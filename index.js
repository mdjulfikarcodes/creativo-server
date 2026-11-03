import express from "express";
import cors from "cors";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";

const PORT = process.env.PORT || 5000;
const CLIENT_ORIGINS = [
  "http://localhost:3000",
  "http://127.0.0.1:3000",
  process.env.CLIENT_ORIGIN,
].filter(Boolean);

const app = express();

app.use(
  cors({
    origin: CLIENT_ORIGINS,
    credentials: true,
  })
);
app.use(express.json());

const client = new MongoClient(process.env.MONGO_URI);

async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("You successfully connected to MongoDB!");
    return client;
  } catch (err) {
    console.error("MongoDB connection failed:", err);
    process.exit(1);
  }
}

const connectedClient = await connectToMongoDB();
const db = connectedClient.db("creativo");
const studiosCollection = db.collection("studio");
const bookingsCollection = db.collection("booking");

const STUDIO_REQUIRED_FIELDS = [
  "title",
  "category",
  "location",
  "overview",
  "hourlyRate",
  "securityDeposit",
  "maxCapacity",
  "imageUrl",
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
    if (
      value !== undefined &&
      value !== null &&
      String(value).trim() !== "" &&
      !Number.isFinite(Number(value))
    ) {
      errors[field] = `${field} must be a number.`;
    }
  }

  if (!Array.isArray(body?.amenities) || body.amenities.length === 0) {
    errors.amenities = "Select at least one amenity.";
  } else if (!body.amenities.every((item) => typeof item === "string")) {
    errors.amenities = "amenities must be an array of strings.";
  }

  if (
    typeof body?.hostEmail === "string" &&
    body.hostEmail &&
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(body.hostEmail)
  ) {
    errors.hostEmail = "hostEmail must be a valid email address.";
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

app.post("/studio", async (req, res) => {
  const errors = validateStudio(req.body);

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({
      message: `Invalid studio data: ${Object.values(errors).join(" ")}`,
      errors,
    });
  }

  try {
    const studio = normalizeStudio(req.body);
    const result = await studiosCollection.insertOne(studio);

    res.status(201).json({
      message: "Studio created successfully.",
      insertedId: result.insertedId,
      studio: { ...studio, _id: result.insertedId },
    });
  } catch (error) {
    console.error("POST /studio failed:", error);
    res.status(500).json({
      message: "Failed to create studio.",
      error: error.message,
    });
  }
});

app.get("/studio", async (req, res) => {
  try {
    const result = await studiosCollection.find().toArray();
    res.json(result);
  } catch (error) {
    console.error("GET /studio failed:", error);
    res.status(500).json({
      message: "Failed to load studios.",
      error: error.message,
    });
  }
});

app.get("/studio/:id", async (req, res) => {
  const { id } = req.params;

  try {
    const query = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { id }] }
      : { id };

    const result = await studiosCollection.findOne(query);

    if (!result) {
      return res.status(404).json({ message: "Studio not found." });
    }

    res.json(result);
  } catch (error) {
    console.error("GET /studio/:id failed:", error);
    res.status(500).json({
      message: "Failed to load studio.",
      error: error.message,
    });
  }
});

const BOOKING_REQUIRED_FIELDS = [
  "studioId",
  "studioTitle",
  "userEmail",
  "date",
  "startTime",
  "endTime",
  "totalPrice",
];

function validateBooking(body) {
  const errors = {};

  for (const field of BOOKING_REQUIRED_FIELDS) {
    const value = body?.[field];
    if (value === undefined || value === null || String(value).trim() === "") {
      errors[field] = `${field} is required.`;
    }
  }

  if (
    body?.totalPrice !== undefined &&
    !Number.isFinite(Number(body.totalPrice))
  ) {
    errors.totalPrice = "totalPrice must be a number.";
  }

  if (
    body?.startTime &&
    body?.endTime &&
    String(body.startTime) >= String(body.endTime)
  ) {
    errors.endTime = "endTime must be later than startTime.";
  }

  return errors;
}

app.post("/booking", async (req, res) => {
  const errors = validateBooking(req.body);

  if (Object.keys(errors).length > 0) {
    return res.status(400).json({
      message: `Invalid booking data: ${Object.values(errors).join(" ")}`,
      errors,
    });
  }

  try {
    const conflict = await bookingsCollection.findOne({
      studioId: String(req.body.studioId),
      date: req.body.date,
      status: { $ne: "Cancelled" },
      startTime: { $lt: req.body.endTime },
      endTime: { $gt: req.body.startTime },
    });

    if (conflict) {
      return res.status(409).json({ message: "Time slot already booked." });
    }

    // 👇 এই অংশটুকু নতুন যোগ করা হয়েছে স্টুডিওর ইমেজ নেওয়ার জন্য
    const studio = await studiosCollection.findOne(
      ObjectId.isValid(req.body.studioId) 
        ? { $or: [{ _id: new ObjectId(req.body.studioId) }, { id: req.body.studioId }] }
        : { id: req.body.studioId }
    );

    const booking = {
      ...req.body,
      studioImage: req.body.studioImage || studio?.imageUrl || "", // 👈 ইমেজটি সেভ হবে
      totalPrice: Number(req.body.totalPrice),
      status: "Pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(booking);

    res.status(201).json({
      message: "Booking created successfully.",
      insertedId: result.insertedId,
      booking: { ...booking, _id: result.insertedId },
    });
  } catch (error) {
    console.error("POST /booking failed:", error);
    res.status(500).json({
      message: "Failed to create booking.",
      error: error.message,
    });
  }
});

app.get("/booking/my-bookings", async (req, res) => {
  try {
    const { userEmail } = req.query;
    const query =
      typeof userEmail === "string" && userEmail ? { userEmail } : {};
    const result = await bookingsCollection
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    res.json(result);
  } catch (error) {
    console.error("GET /booking/my-bookings failed:", error);
    res.status(500).json({
      message: "Failed to load bookings.",
      error: error.message,
    });
  }
});

app.patch("/booking/:id/cancel", async (req, res) => {
  const { id } = req.params;

  try {
    const query = ObjectId.isValid(id)
      ? { $or: [{ _id: new ObjectId(id) }, { id }] }
      : { id };

    const result = await bookingsCollection.findOneAndUpdate(
      query,
      { $set: { status: "Cancelled", updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result) {
      return res.status(404).json({ message: "Booking not found." });
    }

    res.json({
      message: "Booking cancelled successfully.",
      booking: result,
    });
  } catch (error) {
    console.error("PATCH /booking/:id/cancel failed:", error);
    res.status(500).json({
      message: "Failed to cancel booking.",
      error: error.message,
    });
  }
});

app.get("/", (req, res) => {
  res.send("Hello World!");
});

app.use((req, res) => {
  res.status(404).json({
    message: `Route ${req.method} ${req.originalUrl} not found.`,
  });
});

app.use((err, req, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({
    message: "Internal server error.",
    error: err.message,
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
});