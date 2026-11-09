import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { MongoClient, ObjectId } from "mongodb";
import multer from "multer";
import axios from "axios";
import rateLimit from "express-rate-limit";
import FormData from "form-data";
import "dotenv/config";

import { betterAuth } from "better-auth";
import { mongodbAdapter } from "better-auth/adapters/mongodb";
import { toNodeHandler } from "better-auth/node";

const PORT = process.env.PORT || 5000;
const DB_NAME = process.env.DB_NAME || "creativo";

const app = express();

app.use(cors({ 
  origin: process.env.CLIENT_ORIGIN || "http://localhost:3000", 
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
}));

const client = new MongoClient(process.env.MONGO_URI);

async function connectDB() {
  try {
    await client.connect();
    console.log("MongoDB Connected");
    return client;
  } catch (err) {
    console.error("MongoDB Error:", err);
    process.exit(1);
  }
}

const dbClient = await connectDB();
const db = dbClient.db(DB_NAME);

const auth = betterAuth({
  database: mongodbAdapter(db, { client }),
  secret: process.env.BETTER_AUTH_SECRET || "your-secret-key-fallback",
  baseURL: process.env.BETTER_AUTH_URL || "http://localhost:5000",
  trustedOrigins: ["http://localhost:3000", process.env.CLIENT_ORIGIN || ""],
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    },
  },
  account: {
    accountLinking: {
      enabled: true,
      trustedProviders: ["google", "email-password"],
    },
  },
  advanced: {
    defaultCookieAttributes: {
      sameSite: "lax",
      secure: false,
    },
  },
});

app.all("/api/auth/*splat", toNodeHandler(auth));

app.use(express.json());
app.use(cookieParser());

const studios = db.collection("studio");
const bookings = db.collection("booking");
const wishlists = db.collection("wishlist");
const reviews = db.collection("reviews");
const newsletters = db.collection("newsletter");

// Indexes
await studios.createIndex({ title: "text", location: "text" }, { name: "title_text_location_text" }).catch(() => {});
await studios.createIndex({ ownerEmail: 1 }, { name: "studio_owner_email_idx" }).catch(() => {});
await bookings.createIndex({ userEmail: 1, createdAt: -1 }, { name: "booking_user_created_idx" }).catch(() => {});
await bookings.createIndex({ studioId: 1, status: 1 }, { name: "studio_status_idx" }).catch(() => {});
await newsletters.createIndex({ email: 1 }, { unique: true, name: "newsletter_email_unique_idx" }).catch(() => {});

// Auth Middleware
const proxyAuth = async (req, res) => {
  try {
    const session = await auth.api.getSession({
      headers: req.headers,
    });

    if (!session || !session.user) {
      res.status(401).json({ message: "Please login first" });
      return false;
    }

    req.user = {
      email: session.user.email,
      _id: session.user.id,
      name: session.user.name || "User",
    };
    return true;
  } catch (err) {
    console.error("Auth Error:", err.message);
    res.status(401).json({ message: "Authentication failed" });
    return false;
  }
};

const withAuth = (handler) => async (req, res) => {
  const ok = await proxyAuth(req, res);
  if (!ok) return;
  return handler(req, res);
};

const withOwnership = (resourceType) => (handler) => async (req, res) => {
  const ok = await proxyAuth(req, res);
  if (!ok) return;

  const id = req.params.id;
  const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };

  if (resourceType === "studio") {
    const studio = await studios.findOne(query);
    if (!studio) return res.status(404).json({ message: "Studio not found" });
    const isOwner = studio.ownerEmail === req.user.email || studio.ownerId === req.user._id;
    if (!isOwner) return res.status(403).json({ message: "Forbidden: not your studio" });
    return handler(req, res);
  }

  if (resourceType === "booking") {
    const booking = await bookings.findOne(query);
    if (!booking) return res.status(404).json({ message: "Booking not found" });
    
    const studioQuery = ObjectId.isValid(booking.studioId) ? { _id: new ObjectId(booking.studioId) } : { id: booking.studioId };
    const studio = await studios.findOne(studioQuery);
    
    const isBooker = booking.userEmail === req.user.email;
    const isStudioOwner = studio ? studio.ownerEmail === req.user.email || studio.ownerId === req.user._id : false;

    const isConfirm = req.path.includes("/confirm");
    
    if (isConfirm) {
      if (!isStudioOwner && !isBooker) {
        return res.status(403).json({ message: "Forbidden: not your booking or studio" });
      }
    } else {
      if (!isBooker && !isStudioOwner) {
        return res.status(403).json({ message: "Forbidden: not your booking" });
      }
    }

    return handler(req, res);
  }
  return handler(req, res);
};

// ================= STUDIO ROUTES =================
app.get("/studio", async (req, res) => {
  try {
    const { ownerEmail, category, location, search, page, limit } = req.query;
    let query = {};

    if (ownerEmail) query.ownerEmail = ownerEmail;
    if (category) query.category = { $regex: category, $options: "i" };
    if (location) query.location = { $regex: location, $options: "i" };

    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { location: { $regex: search, $options: "i" } },
      ];
    }

    const currentPage = Math.max(parseInt(page, 10) || 1, 1);
    const currentLimit = Math.min(Math.max(parseInt(limit, 10) || 9, 1), 50);
    const skip = (currentPage - 1) * currentLimit;

    const total = await studios.countDocuments(query);
    const data = await studios.find(query).skip(skip).limit(currentLimit).toArray();
    const totalPages = Math.ceil(total / currentLimit);

    res.json({
      data,
      meta: { page: currentPage, limit: currentLimit, total, totalPages },
    });
  } catch (error) {
    res.status(500).json({ message: "Failed to get studios" });
  }
});

app.get("/studio/:id", async (req, res) => {
  try {
    const id = req.params.id;
    let result;

    if (ObjectId.isValid(id)) {
      result = await studios.findOne({ _id: new ObjectId(id) });
    } else {
      result = await studios.findOne({ id: id });
    }

    if (!result) return res.status(404).json({ message: "Studio not found" });

    const studioReviews = await reviews.find({ studioId: String(result._id) }).toArray();
    result.reviewList = studioReviews;
    result.reviews = studioReviews.length;

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to get studio" });
  }
});

app.post("/studio", withAuth(async (req, res) => {
  try {
    const { title, category, hourlyRate, securityDeposit, capacity, location, imageUrl, amenities, overview } = req.body;

    const newStudio = {
      title,
      category,
      hourlyRate,
      securityDeposit,
      capacity,
      location,
      imageUrl,
      amenities,
      overview,
      ownerEmail: req.user.email,
      ownerId: req.user._id,
      hostName: req.user.name,
      rating: 0,
      reviews: 0,
      createdAt: new Date(),
    };

    const result = await studios.insertOne(newStudio);
    res.status(201).json({ message: "Studio created", studio: { ...newStudio, _id: result.insertedId } });
  } catch (error) {
    res.status(500).json({ message: "Failed to create studio" });
  }
}));

app.patch("/studio/:id", withOwnership("studio")(async (req, res) => {
  try {
    const id = req.params.id;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };

    // Mass Assignment Protection: Remove ownership fields from update payload
    const { ownerEmail, ownerId, _id, createdAt, ...safeUpdateData } = req.body;

    const result = await studios.findOneAndUpdate(
      query,
      { $set: { ...safeUpdateData, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ message: "Studio not found" });
    res.json({ message: "Studio updated", studio: result });
  } catch (error) {
    res.status(500).json({ message: "Failed to update studio" });
  }
}));

app.delete("/studio/:id", withOwnership("studio")(async (req, res) => {
  try {
    const id = req.params.id;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };

    const result = await studios.findOneAndDelete(query);
    if (!result) return res.status(404).json({ message: "Studio not found" });

    res.json({ message: "Studio deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete studio" });
  }
}));

// ================= BOOKING ROUTES =================

app.get("/booking/my-bookings", withAuth(async (req, res) => {
  try {
    const result = await bookings.find({ userEmail: req.user.email }).toArray();
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to get bookings" });
  }
}));

app.get("/booking/studio-bookings", withAuth(async (req, res) => {
  try {
    const ownerStudios = await studios.find({ ownerEmail: req.user.email }).toArray();
    const ownerStudioIds = ownerStudios.map((s) => String(s._id));

    if (ownerStudioIds.length === 0) return res.json([]);

    const result = await bookings.find({ studioId: { $in: ownerStudioIds } }).toArray();
    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to get studio bookings" });
  }
}));

app.post("/booking", withAuth(async (req, res) => {
  try {
    const { studioId, date, startTime, endTime, totalPrice } = req.body;

    const overlappingBooking = await bookings.findOne({
      studioId: String(studioId),
      date: date,
      status: "Confirmed",
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    });

    if (overlappingBooking) {
      return res.status(409).json({ message: "This studio is already booked for the selected time" });
    }

    const newBooking = {
      studioId,
      date,
      startTime,
      endTime,
      totalPrice,
      userEmail: req.user.email,
      userName: req.user.name,
      status: "Pending",
      createdAt: new Date(),
    };

    await bookings.insertOne(newBooking);
    res.status(201).json({ message: "Booking created successfully" });
  } catch (error) {
    res.status(500).json({ message: "Failed to create booking" });
  }
}));

app.patch("/booking/:id/confirm", withOwnership("booking")(async (req, res) => {
  try {
    const id = req.params.id;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };

    const existing = await bookings.findOne(query);
    if (!existing) return res.status(404).json({ message: "Booking not found" });

    const overlappingBooking = await bookings.findOne({
      studioId: existing.studioId,
      date: existing.date,
      status: "Confirmed",
      _id: { $ne: existing._id },
      startTime: { $lt: existing.endTime },
      endTime: { $gt: existing.startTime },
    });

    if (overlappingBooking) {
      return res.status(409).json({ message: "This studio is already booked for the selected time" });
    }

    const result = await bookings.findOneAndUpdate(
      query,
      { $set: { status: "Confirmed" } },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ message: "Booking not found" });
    res.json({ message: "Booking confirmed" });
  } catch (error) {
    res.status(500).json({ message: "Failed to confirm booking" });
  }
}));

app.patch("/booking/:id/cancel", withOwnership("booking")(async (req, res) => {
  try {
    const id = req.params.id;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };

    const result = await bookings.findOneAndUpdate(
      query,
      { $set: { status: "Cancelled" } },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ message: "Booking not found" });
    res.json({ message: "Booking cancelled" });
  } catch (error) {
    res.status(500).json({ message: "Failed to cancel booking" });
  }
}));

app.delete("/booking/:id", withOwnership("booking")(async (req, res) => {
  try {
    const id = req.params.id;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };

    const result = await bookings.findOneAndDelete(query);
    if (!result) return res.status(404).json({ message: "Booking not found" });

    res.json({ message: "Booking deleted" });
  } catch (error) {
    res.status(500).json({ message: "Failed to delete booking" });
  }
}));

// ================= REVIEW ROUTES =================
app.post("/studio/:id/review", withAuth(async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const studioId = req.params.id;

    if (!rating || !comment) {
      return res.status(400).json({ message: "Rating and comment required" });
    }

    const newReview = {
      studioId: studioId,
      userEmail: req.user.email,
      userName: req.user.name,
      rating: Number(rating),
      comment: comment,
      createdAt: new Date(),
    };

    await reviews.insertOne(newReview);

    const allReviews = await reviews.find({ studioId: studioId }).toArray();
    let total = 0;
    allReviews.forEach((r) => (total += r.rating));
    const avg = total / allReviews.length;

    const query = ObjectId.isValid(studioId) ? { _id: new ObjectId(studioId) } : { id: studioId };
    await studios.updateOne(query, { $set: { rating: avg.toFixed(1), reviews: allReviews.length } });

    res.status(201).json({ message: "Review added" });
  } catch (error) {
    res.status(500).json({ message: "Failed to add review" });
  }
}));

// ================= WISHLIST ROUTES =================
app.post("/wishlist", withAuth(async (req, res) => {
  try {
    const { studioId } = req.body;
    if (!studioId) return res.status(400).json({ message: "Studio ID required" });

    const existing = await wishlists.findOne({ userEmail: req.user.email, studioId: studioId });

    if (existing) {
      await wishlists.deleteOne({ _id: existing._id });
      return res.json({ message: "Removed from wishlist" });
    }

    await wishlists.insertOne({ userEmail: req.user.email, studioId: studioId });
    res.status(201).json({ message: "Added to wishlist" });
  } catch (error) {
    res.status(500).json({ message: "Wishlist error" });
  }
}));

app.get("/wishlist", withAuth(async (req, res) => {
  try {
    const userWishlist = await wishlists.find({ userEmail: req.user.email }).toArray();
    const ids = userWishlist.map((w) => w.studioId);

    if (ids.length === 0) return res.json([]);

    const objectIds = ids.filter((id) => ObjectId.isValid(id)).map((id) => new ObjectId(id));
    const result = await studios.find({ _id: { $in: objectIds } }).toArray();

    res.json(result);
  } catch (error) {
    res.status(500).json({ message: "Failed to get wishlist" });
  }
}));

app.get("/wishlist/:studioId", withAuth(async (req, res) => {
  try {
    const { studioId } = req.params;
    const existing = await wishlists.findOne({ userEmail: req.user.email, studioId: studioId });
    res.json({ isWishlisted: !!existing });
  } catch (error) {
    res.status(500).json({ message: "Failed to check wishlist" });
  }
}));

// ================= NEWSLETTER & UPLOAD =================
const newsletterLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: { message: "Too many requests. Please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

app.post("/newsletter", newsletterLimiter, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ message: "Email required" });

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      return res.status(400).json({ message: "Invalid email address" });
    }

    const existing = await newsletters.findOne({ email: email });
    if (existing) {
      return res.status(409).json({ message: "This email is already subscribed" });
    }

    await newsletters.insertOne({ email: email, createdAt: new Date() });
    res.status(201).json({ message: "Subscribed successfully" });
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ message: "This email is already subscribed" });
    }
    res.status(500).json({ message: "Failed to subscribe" });
  }
});

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith("image/")) {
      cb(null, true);
    } else {
      cb(new Error("Only image files are allowed"), false);
    }
  },
});

app.post("/upload", upload.single("image"), withAuth(async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ message: "No image file provided" });
    }

    const base64Image = req.file.buffer.toString("base64");
    
    const formData = new FormData();
    formData.append("image", base64Image);

    const response = await axios.post(
      `https://api.imgbb.com/1/upload?key=${process.env.IMGBB_API_KEY}`,
      formData,
      { headers: formData.getHeaders() }
    );

    res.json({ url: response.data.data.url });
  } catch (error) {
    console.error("Upload Error:", error.message);
    res.status(500).json({ message: "Upload failed" });
  }
}));

// ERROR HANDLING
app.get("/", (req, res) => res.send("Server is running"));

app.use((req, res) => {
  res.status(404).json({ message: "Route not found" });
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));