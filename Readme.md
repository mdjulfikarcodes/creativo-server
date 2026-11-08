# Creativo Backend — Studio Booking API

This is the backend server for **Creativo**, a studio booking marketplace. It is built with **Express.js** and **MongoDB**, handling authentication, studio management, bookings, reviews, wishlists, and image uploads.

## 🚀 Live API URL
- **API Base URL:** `https://your-backend-url.onrender.com` *(Replace with your live URL)*

## 🛠️ Tech Stack
- **Node.js** & **Express.js**
- **MongoDB** (Native Driver)
- **JWT** (HTTPOnly Cookies for Auth)
- **Zod** (Server-side Validation)
- **Multer & ImgBB** (Image Upload)
- **Axios** (External API calls)

## 📦 Features
- 🔐 **Authentication:** Login/Logout with JWT stored in HTTPOnly cookies.
- 🏢 **Studio CRUD:** Create, Read, Update, Delete studios with ownership authorization.
- 📅 **Booking System:** Create bookings with **Double-Booking Prevention** (409 Conflict).
- ⭐ **Reviews:** Only users with a *Completed/Confirmed* booking can review.
- ❤️ **Wishlist:** Add/Remove favorite studios.
- 🖼️ **Image Upload:** Upload studio images directly to ImgBB.
- 📧 **Newsletter:** Subscribe to the newsletter.
- 🛡️ **Security:** Zod validation on all POST/PATCH routes, JWT verification middleware.

## ⚙️ Local Setup

### 1. Clone the repository
```bash
git clone https://github.com/your-username/creativo-server.git
cd creativo-server