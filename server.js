import express from "express";
import bodyParser from "body-parser";
import dotenv from "dotenv";
import OpenAI from "openai";
import fetch from "node-fetch";
import { parse } from "csv-parse/sync";

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(express.static("public"));
app.use(bodyParser.json());

// OpenAI client
const client = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ---------- UTIL: LOAD CSV FROM GOOGLE SHEETS ---------- //

async function loadCsv(url) {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch CSV from ${url}: ${res.status}`);
  }
  const text = await res.text();
  const records = parse(text, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });
  return records;
}

// ---------- LOAD ALL EVENT DATA FROM SHEETS ---------- //

let cachedEventData = null;
let lastLoadedMs = 0;
const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

async function buildEventDataFromSheets() {
  const metaUrl = process.env.META_CSV_URL;
  const eventsUrl = process.env.EVENTS_CSV_URL;
  const hotelsUrl = process.env.HOTELS_CSV_URL;
  const guestsUrl = process.env.GUESTS_CSV_URL;

  if (!metaUrl || !eventsUrl) {
    throw new Error("META_CSV_URL or EVENTS_CSV_URL missing in .env");
  }

  // Load required
  const metaRows = await loadCsv(metaUrl);
  const eventRows = await loadCsv(eventsUrl);

  // Load optional
  let hotelsRows = [];
  if (hotelsUrl) {
    hotelsRows = await loadCsv(hotelsUrl);
  }

  let guestsRows = [];
  if (guestsUrl) {
    guestsRows = await loadCsv(guestsUrl);
  }

  // Meta -> key/value map
  const meta = {};
  for (const row of metaRows) {
    if (row.field) {
      meta[row.field] = row.value ?? "";
    }
  }

  // Events
  const events = eventRows.map((r) => ({
    key: r.key,
    name: r.name,
    date: r.date,
    time: r.time,
    venue: r.venue,
    address: r.address,
    mapLink: r.mapLink,
    dressCode: r.dressCode,
  }));

  // Hotels
  const hotels = hotelsRows.map((h) => ({
    name: h.name,
    type: h.type,
    address: h.address,
    mapLink: h.mapLink,
    priceRange: h.priceRange,
    bookingLink: h.bookingLink,
    contactPerson: h.contactPerson,
    contactPhone: h.contactPhone,
    notes: h.notes,
  }));

  // Guests (for booking lookup)
  const guests = guestsRows.map((g) => ({
    phone: g.phone,
    name: g.name,
    hotelName: g.hotelName,
    roomNo: g.roomNo,
    notes: g.notes,
  }));

  const eventData = {
    coupleNames: meta.coupleNames || "",
    weddingName: meta.weddingName || "",
    city: meta.city || "",
    events,
    hotels,
    guests,

    // Optional generic stay info from Meta sheet (if you still want it)
    stay: meta.hotelName
      ? {
          hotelName: meta.hotelName,
          address: meta.hotelAddress,
          mapLink: meta.hotelMapLink,
          checkIn: meta.hotelCheckIn,
          checkOut: meta.hotelCheckOut,
          contactPerson: meta.hotelContactPerson,
          contactPhone: meta.hotelContactPhone,
        }
      : null,

    emergencyContact: meta.emergencyName
      ? {
          name: meta.emergencyName,
          phone: meta.emergencyPhone,
        }
      : null,
  };

  return eventData;
}

async function getEventData() {
  const now = Date.now();
  if (cachedEventData && now - lastLoadedMs < CACHE_TTL_MS) {
    return cachedEventData;
  }
  const data = await buildEventDataFromSheets();
  cachedEventData = data;
  lastLoadedMs = now;
  return data;
}

// ---------- CONTEXT STRING FOR THE AI ---------- //

function buildContextFromEventData(EVENT_DATA) {
  const lines = [];

  lines.push(`Wedding: ${EVENT_DATA.weddingName} in ${EVENT_DATA.city}`);
  lines.push(`Couple: ${EVENT_DATA.coupleNames}`);
  lines.push("");
  lines.push("EVENT SCHEDULE:");
  EVENT_DATA.events.forEach((e, idx) => {
    lines.push(
      `${idx + 1}. ${e.name} (${e.key}) on ${e.date} at ${e.time}, ` +
        `Venue: ${e.venue}, Address: ${e.address}, Map: ${e.mapLink}, Dress code: ${e.dressCode}`
    );
  });

  lines.push("");
  if (EVENT_DATA.stay) {
    const s = EVENT_DATA.stay;
    lines.push(
      `STAY: Hotel ${s.hotelName}, ${s.address}, Map: ${s.mapLink}, ` +
        `Check-in: ${s.checkIn}, Check-out: ${s.checkOut}, ` +
        `Contact: ${s.contactPerson} (${s.contactPhone}).`
    );
  }

  if (EVENT_DATA.emergencyContact) {
    const c = EVENT_DATA.emergencyContact;
    lines.push(`EMERGENCY CONTACT: ${c.name}, Phone: ${c.phone}.`);
  }

  lines.push("");

  if (EVENT_DATA.hotels && EVENT_DATA.hotels.length > 0) {
    lines.push("HOTEL OPTIONS:");
    EVENT_DATA.hotels.forEach((h, idx) => {
      lines.push(
        `${idx + 1}. ${h.name} (${h.type || "Hotel"}) - Address: ${h.address}. ` +
          `Map: ${h.mapLink}. Price: ${h.priceRange}. ` +
          `Booking: ${h.bookingLink}. Contact: ${h.contactPerson} (${h.contactPhone}). Notes: ${h.notes}`
      );
    });
  }

  // Guests data is NOT exposed directly here (we handle booking lookup separately)
  return lines.join("\n");
}

// ---------- HELPER: NORMALIZE PHONE NUMBERS ---------- //

function normalizePhone(raw) {
  if (!raw) return "";
  return raw.replace(/\D/g, ""); // keep only digits
}

// ---------- CHAT ENDPOINT ---------- //

app.post("/api/chat", async (req, res) => {
  try {
    const userMessage = (req.body.message || "").toString().slice(0, 500);

    const EVENT_DATA = await getEventData();
    const contextString = buildContextFromEventData(EVENT_DATA);

    // ----- 1) HOTEL BOOKING LOOKUP BY PHONE (BEFORE AI) ----- //

    // Try to extract a phone number from the message
    // Accepts +91XXXXXXXXXX or 10-13 digit sequences
    const phoneRegex = /\+?\d{10,13}/;
    const phoneMatch = userMessage.match(phoneRegex);
    let guestInfo = null;

    if (phoneMatch && EVENT_DATA.guests && EVENT_DATA.guests.length > 0) {
      const rawPhone = phoneMatch[0];
      const normalizedQuery = normalizePhone(rawPhone);

      guestInfo = EVENT_DATA.guests.find((g) => {
        const normalizedGuestPhone = normalizePhone(g.phone);
        return (
          normalizedGuestPhone &&
          normalizedGuestPhone.endsWith(normalizedQuery)
        );
      });
    }

    // If user mentioned a phone number but we don't have booking → say no booking
    if (phoneMatch && !guestInfo) {
      return res.json({
        reply: `
<strong>Hotel Booking:</strong>
Aapke liye abhi tak koi hotel booking nahi hui hai.
Agar aapko stay arrange karwana hai, please directly family se contact karein. 🙂
`.trim(),
      });
    }

    // If we found a matching guest with booking → return booking details directly
    if (guestInfo) {
      const hotel =
        EVENT_DATA.hotels?.find(
          (h) => h.name.toLowerCase() === guestInfo.hotelName?.toLowerCase()
        ) || null;

      return res.json({
        reply: `
<strong>Booking Found for ${guestInfo.name}:</strong>
<strong>Hotel:</strong> ${hotel?.name || guestInfo.hotelName || "N/A"}
<strong>Room:</strong> ${guestInfo.roomNo || "N/A"}
<strong>Address:</strong> ${hotel?.address || "Address not available"}
<strong>Map:</strong> ${hotel?.mapLink || "Map link not available"}
<strong>Contact:</strong> ${hotel?.contactPerson || "N/A"} (${hotel?.contactPhone || "N/A"})
<strong>Notes:</strong> ${guestInfo.notes || hotel?.notes || "Enjoy your stay! 😊"}
`.trim(),
      });
    }

    // ----- 2) NORMAL AI WEDDING ASSISTANT ANSWER ----- //

    const systemPrompt = `
You are "Babli", a friendly AI wedding assistant for the ${EVENT_DATA.weddingName}.
You answer only questions about this wedding:

- Function dates, timings, venues, dress code
- Hotel stay details and general hotel options
- How to reach venues and hotels (use map links)
- Emergency/main contact person

Formatting rules (very important):
- Reply in a clean, multi-line format.
- Use simple HTML <strong> only for labels like:
  <strong>Mehendi Ceremony:</strong>
  <strong>Date:</strong> 10 February 2025
  <strong>Time:</strong> 11:00 AM
  <strong>Venue:</strong> Green Leaf Lawn, Jaipur
  <strong>Dress code:</strong> Green / Yellow Indian ethnic
  <strong>Map:</strong> https://maps.google.com/...
- For hotel info, you can respond like:
  <strong>Hotel:</strong> Hotel Sunshine (Main Hotel)
  <strong>Address:</strong> MI Road, Jaipur
  <strong>Price range:</strong> ₹3000–₹4500 per night
  <strong>Booking link:</strong> https://bookinglink.com/...
- Do NOT use markdown (**bold**, [links](url)) or other HTML tags.
- No bullet symbols like •. Just plain text with line breaks.
- Use light Hinglish (simple Hindi + English), friendly tone.
- Only include information relevant to the guest's question.
- If the question is not about this wedding, politely say you only know wedding details.
`.trim();

    const userPrompt = `
Here are all the current wedding details (from Google Sheets):

${contextString}

Guest message: "${userMessage}"

Now answer as per the rules.
`.trim();

    const completion = await client.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: 220,
    });

    const reply =
      completion.choices[0]?.message?.content?.trim() ||
      "Sorry, abhi main answer nahi de paa rahi hoon.";

    res.json({ reply });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      reply:
        "Oops, Babli Bua ko data load karne mein issue aa gaya. Please thodi der baad try karo.",
    });
  }
});

app.listen(port, () => {
  console.log(`Wedding assistant running on http://localhost:${port}`);
});
