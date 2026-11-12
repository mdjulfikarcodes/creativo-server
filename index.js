import express from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import { MongoClient, ObjectId } from "mongodb";
import "dotenv/config";
import { createRemoteJWKSet, jwtVerify } from "jose";

const PORT = process.env.PORT || 5000;
const app = express();

app.use(cors({ 
  origin: ["http://localhost:3000", "https://creativo-frontend-one.vercel.app"], 
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json({ limit: "50mb" })); 
app.use(cookieParser());

const client = new MongoClient(process.env.MONGO_URI);

async function connectToMongoDB() {
  try {
    await client.connect();
    console.log("Connected to MongoDB");
    return client;
  } catch (err) {
    console.error("MongoDB Error:", err);
    process.exit(1);
  }
}

const connectClient = await connectToMongoDB();
const db = connectClient.db(process.env.DB_NAME || "creativo");

const studiosCollection = db.collection("studio");
const bookingsCollection = db.collection("booking");
const reviewsCollection = db.collection("reviews");
const wishlistsCollection = db.collection("wishlist");
const newslettersCollection = db.collection("newsletter");

const getFrontendUri = () => process.env.FRONTEND_URI || "http://localhost:3000";

const JWKS = createRemoteJWKSet(
  new URL(`${getFrontendUri()}/api/auth/jwks`)
);

const verifyToken = async (req, res, next) => {
  let token = req.cookies?.token || req.cookies?.["better-auth.session_token"];

  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    token = authHeader.split(" ")[1];
  }

  if (!token) {
    return res.status(401).json({ message: "Unauthorized access" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS, {
      issuer: getFrontendUri(),
      audience: getFrontendUri(),
    });
    req.user = payload; 
  } catch (error) {
    console.error("JWT Verify Error:", error.message);
    return res.status(401).json({ message: "Invalid or expired token" });
  }

  next();
};

app.get("/studio", async (req, res) => {
  try {
    const { ownerEmail, category, location, search, minPrice, maxPrice, minCapacity, maxCapacity, page = 1, limit = 9 } = req.query;
    let query = {};

    if (ownerEmail) query.ownerEmail = ownerEmail;
    if (category) query.category = { $regex: category, $options: "i" };
    if (location) query.location = { $regex: location, $options: "i" };
    
    if (search) {
      query.$or = [
        { title: { $regex: search, $options: "i" } },
        { location: { $regex: search, $options: "i" } }
      ];
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

    const pageNum = parseInt(page);
    const limitNum = parseInt(limit);
    const skip = (pageNum - 1) * limitNum;

    const total = await studiosCollection.countDocuments(query);
    const data = await studiosCollection.find(query).skip(skip).limit(limitNum).toArray();

    res.json({
      data,
      meta: { page: pageNum, limit: limitNum, total, totalPages: Math.ceil(total / limitNum) },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to get studios" });
  }
});

app.get("/studio/:id", async (req, res) => {
  try {
    const id = req.params.id;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };
    const result = await studiosCollection.findOne(query);

    if (!result) return res.status(404).json({ message: "Studio not found" });

    const studioReviews = await reviewsCollection.find({ studioId: String(result._id) }).toArray();
    result.reviewList = studioReviews;
    result.reviews = studioReviews.length;

    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to get studio" });
  }
});

app.post("/studio", verifyToken, async (req, res) => {
  try {
    const newStudio = {
      ...req.body,
      ownerEmail: req.user.email,
      hostName: req.user.name || "User",
      rating: 0,
      reviews: 0,
      createdAt: new Date(),
    };

    const result = await studiosCollection.insertOne(newStudio);
    res.status(201).json({ message: "Studio created", studio: { ...newStudio, _id: result.insertedId } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to create studio" });
  }
});

app.patch("/studio/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };

    const result = await studiosCollection.findOneAndUpdate(
      query,
      { $set: { ...req.body, updatedAt: new Date() } },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ message: "Studio not found" });
    res.json({ message: "Studio updated", studio: result });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to update studio" });
  }
});

app.delete("/studio/:id", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };

    const result = await studiosCollection.findOneAndDelete(query);
    if (!result) return res.status(404).json({ message: "Studio not found" });
    res.json({ message: "Studio deleted" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to delete studio" });
  }
});

app.post("/booking", verifyToken, async (req, res) => {
  try {
    const { studioId, date, startTime, endTime } = req.body;

    const existingBooking = await bookingsCollection.findOne({
      studioId: String(studioId),
      date: date,
      status: "Confirmed",
      startTime: { $lt: endTime },
      endTime: { $gt: startTime },
    });

    if (existingBooking) {
      return res.status(400).json({ message: "This time slot is already booked." });
    }

    const newBooking = {
      ...req.body,
      studioId: String(studioId),
      userEmail: req.user.email,
      userName: req.user.name || "User",
      status: "Pending",
      createdAt: new Date(),
    };

    const result = await bookingsCollection.insertOne(newBooking);
    res.status(201).json({ message: "Booking created", booking: { ...newBooking, _id: result.insertedId } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to create booking" });
  }
});

app.get("/booking/my-bookings", verifyToken, async (req, res) => {
  try {
    const result = await bookingsCollection.find({ userEmail: req.user.email }).toArray();
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to get bookings" });
  }
});

app.patch("/booking/:id/confirm", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };

    const result = await bookingsCollection.findOneAndUpdate(
      query,
      { $set: { status: "Confirmed" } },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ message: "Booking not found" });
    res.json({ message: "Booking confirmed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to confirm booking" });
  }
});

app.patch("/booking/:id/cancel", verifyToken, async (req, res) => {
  try {
    const id = req.params.id;
    const query = ObjectId.isValid(id) ? { _id: new ObjectId(id) } : { id: id };

    const result = await bookingsCollection.findOneAndUpdate(
      query,
      { $set: { status: "Cancelled" } },
      { returnDocument: "after" }
    );

    if (!result) return res.status(404).json({ message: "Booking not found" });
    res.json({ message: "Booking cancelled" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to cancel booking" });
  }
});

app.get("/dashboard/overview", verifyToken, async (req, res) => {
  try {
    const userEmail = req.user.email || req.user.sub || req.user.user_email; 

    const studios = await studiosCollection.find({ ownerEmail: userEmail }).toArray();
    
    const stringIds = studios.map((s) => String(s._id));
    const objectIds = studios.map((s) => s._id);
    const studioIds = [...stringIds, ...objectIds];

    let totalBookings = 0;
    let pendingApprovals = 0;
    let totalRevenue = 0;
    let totalReviews = 0;

    if (studioIds.length > 0) {
      const bookings = await bookingsCollection.find({ studioId: { $in: studioIds } }).toArray();
      
      totalBookings = bookings.length;
      
      bookings.forEach((b) => {
        if (b.status === "Pending") pendingApprovals += 1;
        if (b.status === "Confirmed" || b.status === "Completed") {
          totalRevenue += Number(b.totalPrice) || 0;
        }
      });

      totalReviews = await reviewsCollection.countDocuments({ studioId: { $in: studioIds } });
    }

    res.json({
      data: {
        totalStudios: studios.length,
        totalBookings: totalBookings,
        pendingApprovals: pendingApprovals,
        totalRevenue: totalRevenue,
        totalReviews: totalReviews,
      }
    });
  } catch (error) {
    console.error("Dashboard overview error:", error);
    res.status(500).json({ message: "Failed to get dashboard overview" });
  }
});

app.post("/studio/:id/review", verifyToken, async (req, res) => {
  try {
    const { rating, comment } = req.body;
    const studioId = req.params.id;

    const newReview = {
      studioId: studioId,
      userEmail: req.user.email,
      userName: req.user.name || "User",
      rating: Number(rating),
      comment: comment,
      createdAt: new Date(),
    };

    await reviewsCollection.insertOne(newReview);

    const allReviews = await reviewsCollection.find({ studioId: studioId }).toArray();
    const avg = allReviews.reduce((acc, curr) => acc + curr.rating, 0) / allReviews.length;

    const query = ObjectId.isValid(studioId) ? { _id: new ObjectId(studioId) } : { id: studioId };
    await studiosCollection.updateOne(query, { $set: { rating: avg.toFixed(1), reviews: allReviews.length } });

    res.status(201).json({ message: "Review added" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to add review" });
  }
});

app.post("/wishlist", verifyToken, async (req, res) => {
  try {
    const { studioId } = req.body;

    const existing = await wishlistsCollection.findOne({ userEmail: req.user.email, studioId: studioId });

    if (existing) {
      await wishlistsCollection.deleteOne({ _id: existing._id });
      return res.json({ message: "Removed from wishlist" });
    }

    await wishlistsCollection.insertOne({ userEmail: req.user.email, studioId: studioId });
    res.status(201).json({ message: "Added to wishlist" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Wishlist error" });
  }
});

app.get("/wishlist", verifyToken, async (req, res) => {
  try {
    const userWishlist = await wishlistsCollection.find({ userEmail: req.user.email }).toArray();
    const ids = userWishlist.map(w => w.studioId);
    
    if (ids.length === 0) return res.json([]);

    const objectIds = ids.filter(id => ObjectId.isValid(id)).map(id => new ObjectId(id));
    const stringIds = ids.map(id => String(id));
    const allIds = [...objectIds, ...stringIds];

    const result = await studiosCollection.find({ _id: { $in: allIds } }).toArray();
    
    res.json(result);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to get wishlist" });
  }
});

app.post("/newsletter", async (req, res) => {
  try {
    const { email } = req.body;
    await newslettersCollection.insertOne({ email, createdAt: new Date() });
    res.status(201).json({ message: "Subscribed" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Failed to subscribe" });
  }
});

app.post("/upload", verifyToken, async (req, res) => {
  res.json({ success: true, data: { url: "https://images.unsplash.com/photo-1598488035139-bdbb2231ce04" } });
});

app.get("/", (req, res) => res.send("Creativo Server is running"));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});