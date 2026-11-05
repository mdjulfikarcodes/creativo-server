// server/index.js
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { MongoClient, ObjectId } from "mongodb";
import jwt from "jsonwebtoken";
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
const newslettersCollection = db.collection("newsletter");
const reviewsCollection = db.collection("reviews");
const wishlistsCollection = db.collection("wishlist"); // 👈 নতুন কালেকশন

/* ---------- AUTH MIDDLEWARE ---------- */
const verifySession = async (req, res, next) => {
  try {
    let token = req.cookies?.token;
    if (!token) {
      const authHeader = req.headers.authorization;
      token = authHeader?.startsWith("Bearer ") ? authHeader.split(" ")[1] : null;
    }

    if (!token) {
      return res.status(401).json({ message: "Unauthorized. No token provided." });
    }

    const decoded = jwt.verify(token, process.env.BETTER_AUTH_SECRET, {
      algorithms: ["HS256"],
    });

    if (!decoded || !decoded.email) {
      return res.status(401).json({ message: "Unauthorized. Invalid token." });
    }

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

/* ---------- AUTH ROUTES ---------- */
app.post("/auth/login", async (req, res) => {
  const { email, name, image, sub } = req.body;
  if (!email) return res.status(400).json({ message: "Email is required." });

  const payload = { email, name, image, sub: sub || email };
  const token = jwt.sign(payload, process.env.BETTER_AUTH_SECRET, {
    algorithm: "HS256",
    expiresIn: "7d",
  });

  res.cookie("token", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 7 * 24 * 60 * 60 * 1000,
    path: "/",
  });

  res.json({ message: "Logged in successfully.", user: payload });
});

app.post("/auth/logout", (req, res) => {
  res.clearCookie("token", { path: "/" });
  res.json({ message: "Logged out successfully." });
});

app.get("/auth/me", verifySession, (req, res) => {
  res.json({ user: req.user });
});

/* ---------- NEWSLETTER ---------- */
app.post("/newsletter", async (req, res) => {
  const { email } = req.body;
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ message: "Valid email is required." });
  }

  try {
    const existing = await newslettersCollection.findOne({ email });
    if (existing) {
      return res.status(200).json({ message: "You are already subscribed!" });
    }

    await newslettersCollection.insertOne({ 
      email, 
      createdAt: new Date() 
    });

    res.status(201).json({ message: "Subscribed successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Failed to subscribe.", error: error.message });
  }
});

/* ---------- WISHLIST (Saved Studios) ---------- */
// 👇 ১. ফেভারিটে যোগ বা রিমুভ করা (Toggle)
app.post("/wishlist", verifySession, async (req, res) => {
  const { studioId } = req.body;
  if (!studioId) return res.status(400).json({ message: "Studio ID is required." });

  try {
    const existing = await wishlistsCollection.findOne({
      userEmail: req.user.email,
      studioId: String(studioId),
    });

    if (existing) {
      // আগে থেকে থাকলে রিমুভ করবে
      await wishlistsCollection.deleteOne({ _id: existing._id });
      return res.json({ message: "Removed from wishlist.", action: "removed" });
    }

    // না থাকলে যোগ করবে
    await wishlistsCollection.insertOne({
      userEmail: req.user.email,
      studioId: String(studioId),
      createdAt: new Date(),
    });

    res.status(201).json({ message: "Added to wishlist.", action: "added" });
  } catch (error) {
    res.status(500).json({ message: "Failed to update wishlist.", error: error.message });
  }
});

// 👇 ২. ইউজারের সব ফেভারিট স্টুডিওর লিস্ট আনা
app.get("/wishlist", verifySession, async (req, res) => {
  try {
    const wishlist = await wishlistsCollection
      .find({ userEmail: req.user.email })
      .toArray();

    const studioIds = wishlist.map((w) => w.studioId);

    // স্টুডিও ডেটা আনা
    const studios = await studiosCollection
      .find({
        $or: [
          { _id: { $in: studioIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id)) } },
          { id: { $in: studioIds } },
        ],
      })
      .toArray();

    res.json(studios);
  } catch (error) {
    res.status(500).json({ message: "Failed to load wishlist.", error: error.message });
  }
});

// 👇 ৩. নির্দিষ্ট স্টুডিও ফেভারিটে আছে কি না চেক করা
app.get("/wishlist/:studioId", verifySession, async (req, res) => {
  const { studioId } = req.params;
  try {
    const existing = await wishlistsCollection.findOne({
      userEmail: req.user.email,
      studioId: String(studioId),
    });
    res.json({ isWishlisted: Boolean(existing) });
  } catch (error) {
    res.status(500).json({ message: "Failed to check wishlist.", error: error.message });
  }
});

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
  let images = [];
  if (Array.isArray(body.images) && body.images.length > 0) {
    images = body.images.filter((url) => url && url.trim() !== "");
  } else if (body.imageUrl) {
    images = [body.imageUrl];
  }

  return {
    ...body,
    images,
    hourlyRate: Number(body.hourlyRate),
    securityDeposit: Number(body.securityDeposit),
    maxCapacity: Number(body.maxCapacity),
    rating: body.rating ? Number(body.rating) : null,
    reviews: 0,
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
    studio.ownerEmail = req.user.email;
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
    const { ownerEmail, category, location, minPrice, maxPrice } = req.query;
    const query = {};

    if (typeof ownerEmail === "string" && ownerEmail.trim() !== "") {
      query.$or = [{ ownerEmail }, { hostEmail: ownerEmail }];
    }

    if (typeof category === "string" && category.trim() !== "") {
      query.category = { $regex: new RegExp(category, "i") };
    }

    if (typeof location === "string" && location.trim() !== "") {
      query.location = { $regex: new RegExp(location, "i") };
    }

    if (minPrice || maxPrice) {
      query.hourlyRate = {};
      if (minPrice) query.hourlyRate.$gte = Number(minPrice);
      if (maxPrice) query.hourlyRate.$lte = Number(maxPrice);
    }

    const result = await studiosCollection.find(query).toArray();
    
    const formatted = result.map((s) => ({
      ...s,
      images: Array.isArray(s.images) && s.images.length > 0 
        ? s.images 
        : s.imageUrl 
          ? [s.imageUrl] 
          : [],
    }));

    res.json(formatted);
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

    const reviewsList = await reviewsCollection
      .find({ studioId: String(result._id) })
      .sort({ createdAt: -1 })
      .toArray();

    const formattedReviews = reviewsList.map((r) => ({
      user: r.userName || "Anonymous",
      rating: r.rating,
      comment: r.comment,
      createdAt: r.createdAt,
    }));

    const images = Array.isArray(result.images) && result.images.length > 0
      ? result.images
      : result.imageUrl
        ? [result.imageUrl]
        : [];

    res.json({ 
      ...result, 
      images, 
      rating: result.rating || null,
      reviews: formattedReviews.length > 0 ? formattedReviews.length : 0,
      reviewList: formattedReviews 
    });
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

    if (req.body.images || req.body.imageUrl) {
      const images = Array.isArray(req.body.images) && req.body.images.length > 0
        ? req.body.images.filter((url) => url && url.trim() !== "")
        : req.body.imageUrl
          ? [req.body.imageUrl]
          : existing.images || [];
      updates.images = images;
    }
    
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
    const { studioId, date, startTime, endTime } = req.body;

    if (!studioId || !date || !startTime || !endTime) {
      return res.status(400).json({ message: "Missing required booking fields." });
    }
    if (startTime >= endTime) {
      return res.status(400).json({ message: "Start time must be before end time." });
    }

    const conflict = await bookingsCollection.findOne({
      $or: [{ studioId: String(studioId) }, { studioId }],
      date: date,
      status: { $in: ["Pending", "Confirmed"] },
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    });

    if (conflict) {
      return res.status(409).json({ 
        message: "This time slot is already booked. Please choose another time." 
      });
    }

    const studio = await studiosCollection.findOne(
      ObjectId.isValid(studioId)
        ? { $or: [{ _id: new ObjectId(studioId) }, { id: studioId }] }
        : { id: studioId }
    );

    const booking = {
      ...req.body,
      userEmail: req.user.email,
      userName: req.user.name,
      studioImage: req.body.studioImage || studio?.imageUrl || "",
      totalPrice: Number(req.body.totalPrice),
      status: "Pending",
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(booking);
    res.status(201).json({ 
      message: "Booking created successfully.", 
      booking: { ...booking, _id: result.insertedId } 
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to create booking.", error: error.message });
  }
});

app.post("/booking/:id/review", verifySession, async (req, res) => {
  const { id } = req.params;
  const { rating, comment } = req.body;
  
  if (!rating || Number(rating) < 1 || Number(rating) > 5) {
    return res.status(400).json({ message: "Rating must be between 1 and 5." });
  }
  if (!comment || comment.trim() === "") {
    return res.status(400).json({ message: "Comment is required." });
  }

  try {
    const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
    const booking = await bookingsCollection.findOne(query);
    
    if (!booking) return res.status(404).json({ message: "Booking not found." });
    if (booking.userEmail !== req.user.email) return res.status(403).json({ message: "Unauthorized to review this booking." });
    if (booking.status !== "Completed") return res.status(400).json({ message: "You can only review completed bookings." });

    const existingReview = await reviewsCollection.findOne({ bookingId: String(booking._id) });
    if (existingReview) return res.status(400).json({ message: "You have already reviewed this booking." });

    await reviewsCollection.insertOne({
      bookingId: String(booking._id),
      studioId: String(booking.studioId),
      userEmail: req.user.email,
      userName: req.user.name || "Anonymous",
      rating: Number(rating),
      comment: comment.trim(),
      createdAt: new Date(),
    });
    
    const allReviews = await reviewsCollection.find({ studioId: String(booking.studioId) }).toArray();
    const avgRating = allReviews.reduce((acc, curr) => acc + curr.rating, 0) / allReviews.length;
    
    const studioQuery = ObjectId.isValid(booking.studioId) 
      ? { $or: [{ _id: new ObjectId(booking.studioId) }, { id: booking.studioId }] } 
      : { id: booking.studioId };
      
    await studiosCollection.updateOne(studioQuery, {
      $set: { 
        rating: Number(avgRating.toFixed(1)), 
        reviews: allReviews.length 
      }
    });

    res.json({ message: "Review added successfully." });
  } catch (error) {
    res.status(500).json({ message: "Failed to add review.", error: error.message });
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
    const result = await bookingsCollection.findOneAndUpdate(
      query, 
      { $set: { status: "Confirmed", updatedAt: new Date() } }, 
      { returnDocument: "after" }
    );
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
    const result = await bookingsCollection.findOneAndUpdate(
      query, 
      { $set: { status: "Cancelled", updatedAt: new Date() } }, 
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ message: "Booking not found." });
    res.json({ message: "Booking cancelled successfully.", booking: result });
  } catch (error) {
    res.status(500).json({ message: "Failed to cancel booking.", error: error.message });
  }
});

app.patch("/booking/:id/complete", verifySession, async (req, res) => {
  const { id } = req.params;
  try {
    const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
    const result = await bookingsCollection.findOneAndUpdate(
      query, 
      { $set: { status: "Completed", updatedAt: new Date() } }, 
      { returnDocument: "after" }
    );
    if (!result) return res.status(404).json({ message: "Booking not found." });
    res.json({ message: "Booking completed successfully.", booking: result });
  } catch (error) {
    res.status(500).json({ message: "Failed to complete booking.", error: error.message });
  }
});

/* ---------- HEALTH / 404 / ERROR ---------- */
app.get("/", (req, res) => res.send("Hello World!"));

app.use((req, res) => res.status(404).json({ message: `Route ${req.method} ${req.originalUrl} not found.` }));

app.use((err, res, next) => {
  console.error("Unhandled error:", err);
  if (res.headersSent) return next(err);
  res.status(500).json({ message: "Internal server error.", error: err.message });
});

app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));