// server/index.js
import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { MongoClient, ObjectId } from "mongodb";
import jwt from "jsonwebtoken";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import { z } from "zod";
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

const upload = multer({ storage: multer.memoryStorage() });

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
const wishlistsCollection = db.collection("wishlist");

/* ---------- ZOD SCHEMAS ---------- */
const StudioSchema = z.object({
  title: z.string().min(5),
  category: z.string().min(1),
  location: z.string().min(3),
  overview: z.string().min(10),
  hourlyRate: z.number().positive(),
  securityDeposit: z.number().nonnegative(),
  maxCapacity: z.number().positive(),
  imageUrl: z.string().url(),
  amenities: z.array(z.string()).min(1),
  images: z.array(z.string().url()).optional(),
});

const BookingSchema = z.object({
  studioId: z.string().min(1),
  date: z.string().min(1),
  startTime: z.string().min(1),
  endTime: z.string().min(1),
  totalPrice: z.number().positive(),
});

const ReviewSchema = z.object({
  rating: z.number().min(1).max(5),
  comment: z.string().min(2),
});

const WishlistSchema = z.object({
  studioId: z.string().min(1),
});

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

/* ---------- IMAGE UPLOAD (ImgBB) ---------- */
app.post("/upload", verifySession, upload.single("image"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No image file provided." });
    }

    const formData = new FormData();
    formData.append("image", req.file.buffer.toString("base64"));

    const imgbbRes = await axios.post(
      `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
      formData,
      { headers: formData.getHeaders() }
    );

    if (imgbbRes.data && imgbbRes.data.data) {
      return res.status(200).json({ url: imgbbRes.data.data.url });
    } else {
      throw new Error("Invalid ImgBB response");
    }
  } catch (error) {
    console.error("Image upload failed:", error.message);
    res.status(500).json({ message: "Failed to upload image.", error: error.message });
  }
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

    await newslettersCollection.insertOne({ email, createdAt: new Date() });
    res.status(201).json({ message: "Subscribed successfully!" });
  } catch (error) {
    res.status(500).json({ message: "Failed to subscribe.", error: error.message });
  }
});

/* ---------- WISHLIST ---------- */
app.post("/wishlist", verifySession, async (req, res) => {
  const parsed = WishlistSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid data", errors: parsed.error.errors });
  }

  const { studioId } = parsed.data;

  try {
    const existing = await wishlistsCollection.findOne({
      userEmail: req.user.email,
      studioId: String(studioId),
    });

    if (existing) {
      await wishlistsCollection.deleteOne({ _id: existing._id });
      return res.json({ message: "Removed from wishlist.", action: "removed" });
    }

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

app.get("/wishlist", verifySession, async (req, res) => {
  try {
    const wishlist = await wishlistsCollection.find({ userEmail: req.user.email }).toArray();
    if (wishlist.length === 0) return res.json([]);

    const studioIds = wishlist.map((w) => w.studioId);
    const objectIds = studioIds.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));

    const studios = await studiosCollection.find({
      $or: [{ _id: { $in: objectIds } }, { id: { $in: studioIds } }],
    }).toArray();

    res.json(studios.map((s) => ({
      ...s,
      images: Array.isArray(s.images) && s.images.length > 0 ? s.images : s.imageUrl ? [s.imageUrl] : [],
    })));
  } catch (error) {
    res.status(500).json({ message: "Failed to load wishlist.", error: error.message });
  }
});

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
app.post("/studio", verifySession, async (req, res) => {
  const parsed = StudioSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid studio data", errors: parsed.error.errors });
  }

  try {
    const studio = parsed.data;
    
    let images = [];
    if (Array.isArray(studio.images) && studio.images.length > 0) {
      images = studio.images;
    } else if (studio.imageUrl) {
      images = [studio.imageUrl];
    }

    const newStudio = {
      ...studio,
      images,
      rating: null,
      reviews: 0,
      ownerEmail: req.user.email,
      hostEmail: req.user.email,
      hostName: req.user.name,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const result = await studiosCollection.insertOne(newStudio);
    res.status(201).json({ message: "Studio created successfully.", studio: { ...newStudio, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ message: "Failed to create studio.", error: error.message });
  }
});

// 👇 Explore পেজের জন্য limit বাড়িয়ে 1000 করা হলো
app.get("/studio", async (req, res) => {
  try {
    const { ownerEmail, category, location, minPrice, maxPrice, minCapacity, maxCapacity, page = 1, limit = 1000 } = req.query;
    
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
    if (minCapacity || maxCapacity) {
      query.maxCapacity = {};
      if (minCapacity) query.maxCapacity.$gte = Number(minCapacity);
      if (maxCapacity) query.maxCapacity.$lte = Number(maxCapacity);
    }

    const pageNum = parseInt(page, 10) || 1;
    const limitNum = parseInt(limit, 10) || 1000;
    const skip = (pageNum - 1) * limitNum;

    const totalStudios = await studiosCollection.countDocuments(query);
    const totalPages = Math.ceil(totalStudios / limitNum);

    const result = await studiosCollection.find(query).skip(skip).limit(limitNum).toArray();
    
    const formatted = result.map((s) => ({
      ...s,
      images: Array.isArray(s.images) && s.images.length > 0 ? s.images : s.imageUrl ? [s.imageUrl] : [],
    }));

    res.json({
      studios: formatted,
      totalPages,
      currentPage: pageNum,
      totalStudios
    });
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

    const reviewsList = await reviewsCollection.find({ studioId: String(result._id) }).sort({ createdAt: -1 }).toArray();
    const formattedReviews = reviewsList.map((r) => ({
      user: r.userName || "Anonymous",
      rating: r.rating,
      comment: r.comment,
      createdAt: r.createdAt,
    }));

    const images = Array.isArray(result.images) && result.images.length > 0 ? result.images : result.imageUrl ? [result.imageUrl] : [];

    res.json({
      ...result,
      images,
      rating: result.rating || null,
      reviews: formattedReviews.length,
      reviewList: formattedReviews,
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to load studio.", error: error.message });
  }
});

app.post("/studio/:id/review", verifySession, async (req, res) => {
  const parsed = ReviewSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid review data", errors: parsed.error.errors });
  }

  const { rating, comment } = parsed.data;
  const { id } = req.params;

  try {
    const studioQuery = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
    const studio = await studiosCollection.findOne(studioQuery);
    if (!studio) return res.status(404).json({ message: "Studio not found." });

    const booking = await bookingsCollection.findOne({
      $or: [{ studioId: String(studio._id) }, { studioId: studio._id }],
      userEmail: req.user.email,
      status: { $in: ["Completed", "Confirmed"] },
    });

    if (!booking) {
      return res.status(403).json({ message: "You must have a confirmed or completed booking to review this studio." });
    }

    const existingReview = await reviewsCollection.findOne({ bookingId: String(booking._id) });
    if (existingReview) return res.status(400).json({ message: "You have already reviewed this booking." });

    await reviewsCollection.insertOne({
      bookingId: String(booking._id),
      studioId: String(studio._id),
      userEmail: req.user.email,
      userName: req.user.name || "Anonymous",
      rating: Number(rating),
      comment: comment.trim(),
      createdAt: new Date(),
    });

    const allReviews = await reviewsCollection.find({ studioId: String(studio._id) }).toArray();
    const avgRating = allReviews.reduce((acc, curr) => acc + curr.rating, 0) / allReviews.length;

    await studiosCollection.updateOne(studioQuery, {
      $set: { rating: Number(avgRating.toFixed(1)), reviews: allReviews.length },
    });

    res.status(201).json({ message: "Review added successfully." });
  } catch (error) {
    res.status(500).json({ message: "Failed to add review.", error: error.message });
  }
});

app.patch("/studio/:id", verifySession, async (req, res) => {
  const { id } = req.params;
  const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
  try {
    const existing = await studiosCollection.findOne(query);
    if (!existing) return res.status(404).json({ message: "Studio not found." });

    if (existing.ownerEmail !== req.user.email && existing.hostEmail !== req.user.email) {
      return res.status(403).json({ message: "Unauthorized to edit this studio." });
    }

    const updates = { updatedAt: new Date() };
    for (const key of Object.keys(req.body)) { updates[key] = req.body[key]; }

    if (req.body.images || req.body.imageUrl) {
      const images = Array.isArray(req.body.images) && req.body.images.length > 0
        ? req.body.images.filter((url) => url && url.trim() !== "")
        : req.body.imageUrl ? [req.body.imageUrl] : existing.images || [];
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
    const existing = await studiosCollection.findOne(query);
    if (!existing) return res.status(404).json({ message: "Studio not found." });

    if (existing.ownerEmail !== req.user.email && existing.hostEmail !== req.user.email) {
      return res.status(403).json({ message: "Unauthorized to delete this studio." });
    }

    const result = await studiosCollection.findOneAndDelete(query);
    if (!result) return res.status(404).json({ message: "Studio not found." });
    res.json({ message: "Studio deleted successfully.", deletedId: id });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete studio.", error: error.message });
  }
});

/* ---------- BOOKING ---------- */
app.post("/booking", verifySession, async (req, res) => {
  const parsed = BookingSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: "Invalid booking data", errors: parsed.error.errors });
  }

  const { studioId, date, startTime, endTime, totalPrice } = parsed.data;

  try {
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
      return res.status(409).json({ message: "This time slot is already booked. Please choose another time." });
    }

    const studio = await studiosCollection.findOne(
      ObjectId.isValid(studioId) ? { $or: [{ _id: new ObjectId(studioId) }, { id: studioId }] } : { id: studioId }
    );

    const booking = {
      ...req.body,
      userEmail: req.user.email,
      userName: req.user.name,
      studioImage: req.body.studioImage || studio?.imageUrl || "",
      totalPrice: Number(totalPrice),
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

app.patch("/booking/:id/complete", verifySession, async (req, res) => {
  const { id } = req.params;
  try {
    const query = ObjectId.isValid(id) ? { $or: [{ _id: new ObjectId(id) }, { id }] } : { id };
    const result = await bookingsCollection.findOneAndUpdate(query, { $set: { status: "Completed", updatedAt: new Date() } }, { returnDocument: "after" });
    if (!result) return res.status(404).json({ message: "Booking not found." });
    res.json({ message: "Booking completed successfully.", booking: result });
  } catch (error) {
    res.status(500).json({ message: "Failed to complete booking.", error: error.message });
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