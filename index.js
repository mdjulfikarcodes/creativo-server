// server/index.js
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { MongoClient, ObjectId } from "mongodb";
import jwt from "jsonwebtoken"; // 👈 jsonwebtoken is used here
import "dotenv/config";

const PORT = process.env.PORT || 5000;
const DB_NAME = process.env.DB_NAME || "creativo";

const CLIENT_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  process.env.CLIENT_ORIGIN,
].filter(Boolean);

const app = express();
app.use(cors({ origin: CLIENT_ORIGINS, credentials: true }));
app.use(express.json());
app.use(cookieParser());

const client = new MongoClient(process.env.MONGO_URI);

async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("✅ Connected to MongoDB");
    return client;
  } catch (err) {
    console.error("❌ MongoDB connection failed:", err);
    process.exit(1);
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db(DB_NAME);
const studiosCollection = db.collection("studio");
const bookingsCollection = db.collection("booking");

/* ---------- AUTH MIDDLEWARE (JWT Verification) ---------- */
const verifySession = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;

    if (!token) {
      return res.status(401).json({ message: "Unauthorized. No token provided." });
    }

    // 👇 Verify Token using jsonwebtoken and HS256
    const decoded = jwt.verify(token, process.env.BETTER_AUTH_SECRET, {
      algorithms: ["HS256"], 
    });

    if (!decoded || !decoded.email) {
      return res.status(401).json({ message: "Unauthorized. Invalid token." });
    }

    // Attach user data to request
    req.user = {
      id: decoded.sub || decoded.id,
      email: decoded.email,
      name: decoded.name,
      image: decoded.image,
    };

    next();
  } catch (error) {
    console.error("JWT Verification Error:", error.message);
    res.status(401).json({ message: "Unauthorized. Invalid or expired token." });
  }
};

/* ---------- STUDIO ---------- */
const STUDIO_REQUIRED_FIELDS = [
  "title", "category", "location", "overview",
  "hourlyRate", "securityDeposit", "maxCapacity", "imageUrl",
];
const STUDIO_NUMERIC_FIELDS = ["hourlyRate", "securityDeposit", "maxCapacity"];

function validateStudio(body) {
  const errors = {};
  for (const field of STUDIO_REQUIRED_FIELDS) {
    const value = body?.[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      errors[field] = `${field} is required.`;
    }
  }
  for (const field of STUDIO_NUMERIC_FIELDS) {
    const value = body?.[field];
    if (value !== undefined && value !== null && String(value).trim() !== "" && !Number.isFinite(Number(value))) {
      errors[field] = `${field} must be a number.`;
    }
  }
  if (!Array.isArray(body?.amenities) || body.amenities.length === 0) {
    errors.amenities = "Select at least one amenity.";
  }
  return errors;
}

function normalizeStudio(body) {
  return {
    ...body,
    hourlyRate: Number(body.hourlyRate),
    securityDeposit: Number(body.securityDeposit),
    maxCapacity: Number(body.maxCapacity),
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

app.post("/studio", verifySession, async (req, res) => {
  const errors = validateStudio(req.body);
  if (Object.keys(errors).length > 0) {
    return res.status(400).json({ message: `Invalid studio data: ${Object.values(errors).join(" ")}`, errors });
  }
  try {
    const studio = normalizeStudio(req.body);
    studio.ownerEmail = req.user.email; // Automatically from JWT
    studio.hostEmail = req.user.email;
    studio.hostName = req.user.name;

    const result = await studiosCollection.insertOne(studio);
    res.status(201).json({ message: "Studio created successfully.", studio: { ...studio, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ message: "Failed to create studio.", error: error.message });
  }
});

app.get("/studio", async (req, res) => {
  try {
    const { ownerEmail } = req.query;
    const query = {};
    if (typeof ownerEmail === "string" && ownerEmail.trim() !== "") {
      query.$or = [{ ownerEmail }, { hostEmail: ownerEmail }];
    }
    const result = await studiosCollection.find(query).toArray();
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to load studios.", error: error.message });
  }
});

app.get("/studio/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
    const result = await studiosCollection.findOne(query);
    if (!result) return res.status(404).json({ message: "Studio not found." });
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to load studio.", error: error.message });
  }
});

app.patch("/studio/:id", verifySession, async (req, res) => {
  const { id } = req.params;
  const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
  try {
    const existing = await studiosCollection.findOne(query);
    if (!existing) return res.status(404).json({ message: "Studio not found." });

    const updates = { updatedAt: new Date() };
    for (const key of Object.keys(req.body)) { updates[key] = req.body[key]; }
    
    const result = await studiosCollection.findOneAndUpdate(query, { $set: updates }, { returnDocument: "after" });
    res.json({ message: "Studio updated successfully.", studio: result });
  } catch (error) {
    res.status(500).json({ message: "Failed to update studio.", error: error.message });
  }
});

app.delete("/studio/:id", verifySession, async (req, res) => {
  const { id } = req.params;
  const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
  try {
    const result = await studiosCollection.findOneAndDelete(query);
    if (!result) return res.status(404).json({ message: "Studio not found." });
    res.json({ message: "Studio deleted successfully.", deletedId: id });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete studio.", error: error.message });
  }
});

/* ---------- BOOKING ---------- */
app.post("/booking", verifySession, async (req, res) => {
  try {
    const conflict = await bookingsCollection.findOne({
      studioId: String(req.body.studioId),
      date: req.body.date,
      status: "Confirmed",
      startTime: { $lt: req.body.endTime },
      endTime: { $gt: req.body.startTime },
    });
    if (conflict) return res.status(409).json({ message: "Time slot already booked." });

    const studio = await studiosCollection.findOne(
      ObjectId.isValid(req.body.studioId)
        ? { $or: [{ _id: new ObjectId(req.body.studioId) }, { id: req.body.studioId }] }
        : { id: req.body.studioId }
    );

    const booking = {
      ...req.body,
      userEmail: req.user.email, // From JWT
      userName: req.user.name,   // From JWT
      studioImage: req.body.studioImage || studio?.imageUrl || "",
      totalPrice: Number(req.body.totalPrice),
      status: "Pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(booking);
    res.status(201).json({ message: "Booking created successfully.", booking: { ...booking, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ message: "Failed to create booking.", error: error.message });
  }
});

app.get("/booking/my-bookings", async (req, res) => {
  try {
    const { userEmail } = req.query;
    const query = typeof userEmail === "string" && userEmail ? { userEmail } : {};
    const result = await bookingsCollection.find(query).sort({ createdAt: -1 }).toArray();
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to load bookings.", error: error.message });
  }
});

app.patch("/booking/:id/confirm", verifySession, async (req, res) => {
  const { id } = req.params;
  try {
    const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
    const result = await bookingsCollection.findOneAndUpdate(query, { $set: { status: "Confirmed", updatedAt: new Date() } }, { returnDocument: "after" });
    if (!result) return res.status(404).json({ message: "Booking not found." });
    res.json({ message: "Booking confirmed successfully.", booking: result });
  } catch (error) {
    res.status(500).json({ message: "Failed to confirm booking.", error: error.message });
  }
});

app.patch("/booking/:id/cancel", verifySession, async (req, res) => {
  const { id } = req.params;
  try {
    const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
    const result = await bookingsCollection.findOneAndUpdate(query, { $set: { status: "Cancelled", updatedAt: new Date() } }, { returnDocument: "after" });
    if (!result) return res.status(404).json({ message: "Booking not found." });
    res.json({ message: "Booking cancelled successfully.", booking: result });
  } catch (error) {
    res.status(500).json({ message: "Failed to cancel booking.", error: error.message });
  }
});

/* ---------- HEALTH / 404 / ERROR ---------- */
app.get("/", (req, res) => res.send("Hello World!"));
app.use((req, res) => res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found.` }));
app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: "Internal server error.", error: err.message });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));