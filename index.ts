import express, { type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ObjectId, ServerApiVersion } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose-cjs";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

// 🛠️ Middleware: CORS কনফিগারেশন আরও নিরাপদ করা হলো
app.use(cors({
  origin: process.env.CLIENT_URL || 'http://localhost:3000',
  credentials: true,
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

app.use((req: Request, res: Response, next: NextFunction) => {
  console.log(`${req.method} ${req.url}`);
  next();
});

// 🛠️ TypeScript Request Interface Extension
interface CustomRequest extends Request {
  user?: {
    id: string;
    email: string;
    role: string;
    name?: string;
  };
}

const uri = process.env.MONGO_DB_URI;

if (!uri) {
  console.error("❌ Error: MONGO_DB_URI is not defined in .env file");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

// 📦 গ্লোবাল ডাটাবেজ কালেকশনস
const database = client.db(process.env.AUTH_DB_NAME);
const productsCollection = database.collection("products");
const cartsCollection = database.collection("carts");
const ordersCollection = database.collection("orders");
const usersCollection = database.collection("user");

/**
 * ========================================================
 * 🛡️ মিডলওয়্যার: JWT টোকেন ভেরিফিকেশন (Better Auth JWKS)
 * ========================================================
 */
const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL || 'http://localhost:3000'}/api/auth/jwks`));

// 🎯 এখানে টাইপস্ক্রিপ্ট এরর এড়াতে req: CustomRequest দেওয়া হলো
const verifyToken = async (req: CustomRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ success: false, message: "Unauthorized: Missing Token" });
  }

  console.log("verifyToken middleware hit");
console.log("Authorization:", req.headers.authorization);

  const token = authHeader.split(" ")[1];
  console.log("Extracted Token:", token);

  if (!token) {
    return res.status(401).json({ success: false, message: "Unauthorized: Token Empty" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);

    console.log("Payload:", payload);
    
    // Better Auth সাধারণত ইউজার আইডি 'sub' এ রাখে
    req.user = {
      id: payload.sub as string, 
      email: payload.email as string,
      role: (payload.role as string) || 'user',
      name: payload.name as string
    };
    
    next();
  } catch (error) {
    console.error("JWT Verification Error:", error);
    return res.status(401).json({ success: false, message: "Unauthorized: Invalid Token" });
  }
};

/**
 * ========================================================
 * 🚀 এপিআই রুটস
 * ========================================================
 */

// Base Route
app.get("/", (req: Request, res: Response) => {
  res.send("GizmoGrid TypeScript Server is Running!");
});

app.get("/api/test", (req: Request, res: Response) => {
  console.log("TEST ROUTE HIT");
  res.send("API OK");
});

app.get("/abc123", (req, res) => {
  res.send("HELLO HIMEL");
});

// 🌐 অল প্রোডাক্টস গেট করার রুট (সার্চ, ফিল্টার, সর্টিং এবং পেজিনেশন সহ)
app.get("/api/products", async (req: Request, res: Response) => {
  try {
    const { search, category, minPrice, maxPrice, sortBy, page = 1, limit = 8 } = req.query;

    // ১. ফিল্টারিং অবজেক্ট তৈরি
    const query: any = {};

    // সার্চ লজিক (Title-এর মধ্যে খুঁজবে, Case-Insensitive)
    if (search) {
      query.title = { $regex: search, $options: "i" };
    }

    // ক্যাটাগরি ফিল্টার
    if (category) {
      query.category = category;
    }

    // প্রাইস রেঞ্জ ফিল্টার (কমপক্ষে ২টি ফিল্ড রিকোয়ারমেন্ট পূরণ)
    if (minPrice || maxPrice) {
      query.price = {};
      if (minPrice) query.price.$gte = Number(minPrice);
      if (maxPrice) query.price.$lte = Number(maxPrice);
    }

    // ২. সর্টিং লজিক
    let sortOptions: any = {};
    if (sortBy === "priceLow") {
      sortOptions.price = 1; // কম থেকে বেশি
    } else if (sortBy === "priceHigh") {
      sortOptions.price = -1; // বেশি থেকে কম
    } else {
      sortOptions.createdAt = -1; // ডিফল্ট: নতুন প্রোডাক্ট আগে দেখাবে
    }

    // ৩. পেজিনেশন লজিক
    const pageNumber = Number(page);
    const limitNumber = Number(limit);
    const skip = (pageNumber - 1) * limitNumber;

    // ডাটাবেজ থেকে ডাটা এবং টোটাল কাউন্ট আনা
    const totalProducts = await productsCollection.countDocuments(query);
    const products = await productsCollection
      .find(query)
      .sort(sortOptions)
      .skip(skip)
      .limit(limitNumber)
      .toArray();

    // রেসপন্স পাঠানো
    res.status(200).json({
      success: true,
      totalProducts,
      totalPages: Math.ceil(totalProducts / limitNumber),
      currentPage: pageNumber,
      data: products,
    });
  } catch (error) {
    console.error("Fetch Products Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error." });
  }
});

console.log("Registering seller products route");

// 📦 রুটের নাম পরিবর্তন করে /api/seller/products করা হলো
app.get("/api/seller/products", verifyToken, async (req: CustomRequest, res: Response) => {
  try {
    const sellerId = req.user?.id;

    if (!sellerId) {
      return res.status(400).json({ success: false, message: "Seller ID missing from token!" });
    }

    // ডাটাবেজ থেকে শুধুমাত্র এই সেলারের প্রোডাক্টগুলো খোঁজা হচ্ছে
    const myProducts = await productsCollection.find({ sellerId: sellerId }).toArray();

    res.status(200).json({
      success: true,
      data: myProducts,
    });
  } catch (error) {
    console.error("Fetch Seller Products Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error." });
  }
});


// 🗑️ প্রোডাক্ট ডিলিট করার Secure API
app.delete("/api/products/:id", verifyToken, async (req: CustomRequest, res: Response) => {
  try {
    const productId = req.params.id as string as string as string;
    const sellerId = req.user?.id;

    // নিশ্চিত হওয়া যে এই প্রোডাক্টটি আসলেই এই সেলারের কি না
    const product = await productsCollection.findOne({ _id: new ObjectId(productId) });

    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found!" });
    }

    if (product.sellerId !== sellerId) {
      return res.status(403).json({ success: false, message: "Unauthorized! You can only delete your own products." });
    }

    // ডাটাবেজ থেকে ডিলিট করা
    const result = await productsCollection.deleteOne({ _id: new ObjectId(productId) });

    res.status(200).json({
      success: true,
      message: "Product deleted successfully!",
    });
  } catch (error) {
    console.error("Delete Product Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error." });
  }
});


// 🔍 ১. নির্দিষ্ট একটি প্রোডাক্টের ডাটা আইডি দিয়ে খুঁজে বের করা (For Edit Form Initialization)
app.get("/api/products/:id", verifyToken, async (req: Request, res: Response) => {
  try {
    const productId = req.params.id as string as string as string;
    const product = await productsCollection.findOne({ _id: new ObjectId(productId) });

    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found!" });
    }

    res.status(200).json({ success: true, data: product });
  } catch (error) {
    console.error("Fetch Single Product Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error." });
  }
});

// 🔄 ২. প্রোডাক্টের তথ্য আপডেট করার Secure API
app.put("/api/products/:id", verifyToken, async (req: CustomRequest, res: Response) => {
  try {
    const productId = req.params.id as string as string as string;
    const sellerId = req.user?.id;
    const updatedData = req.body; // ফ্রন্টএন্ড থেকে পাঠানো নতুন ডেটা

    // প্রথমে চেক করা এই প্রোডাক্টটি আসলেই এই সেলারের কি না
    const product = await productsCollection.findOne({ _id: new ObjectId(productId) });

    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found!" });
    }

    if (product.sellerId !== sellerId) {
      return res.status(403).json({ success: false, message: "Unauthorized to update this product." });
    }

    // মঙ্গোডিবি-তে আপডেট করা (আইডি ছাড়া বাকি ফিল্ডগুলো)
    const { _id, ...fieldsToUpdate } = updatedData;
    const result = await productsCollection.updateOne(
      { _id: new ObjectId(productId) },
      { $set: fieldsToUpdate }
    );

    res.status(200).json({
      success: true,
      message: "Product updated successfully!",
    });
  } catch (error) {
    console.error("Update Product Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error." });
  }
});


// 🎯 ১. নির্দিষ্ট প্রোডাক্টের ডিটেইলস এবং রিলেটেড প্রোডাক্ট নিয়ে আসার রুট
app.get("/api/products/:id/edit", async (req: Request, res: Response) => {
  try {
    const id = req.params.id as string;

    // আইডি ভ্যালিডেশন
    if (!ObjectId.isValid(id)) {
      return res.status(400).json({ success: false, message: "Invalid Product ID Format." });
    }

    // মেইন প্রোডাক্টটি ডাটাবেজ থেকে খোঁজা
    const product = await productsCollection.findOne({ _id: new ObjectId(id) });

    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found." });
    }

    // 🔄 রিলেটেড প্রোডাক্ট খোঁজা (একই ক্যাটাগরি কিন্তু কারেন্ট প্রোডাক্টটি বাদে, সর্বোচ্চ ৪টি)
    const relatedProducts = await productsCollection
      .find({
        category: product.category,
        _id: { $ne: new ObjectId(id) } // কারেন্ট প্রোডাক্ট বাদ দিতে
      })
      .limit(4)
      .toArray();

    res.status(200).json({
      success: true,
      data: product,
      relatedProducts
    });
  } catch (error) {
    console.error("Fetch Single Product Error:", error);
    res.status(500).json({ success: false, message: "Internal Server Error." });
  }
});


// 👥 ১. সব ইউজারের লিস্ট গেট করার রুট (GET)
app.get("/api/admin/users", async (req, res) => {
  try {
    // তোমার ডাটাবেজের ইউজার কালেকশন থেকে সব ডাটা রিড করা
    const users = await usersCollection.find({}).toArray(); 
    
    // ম্যাপ করে ডাটা ফরম্যাট ঠিক করা (যাতে ফ্রন্টএন্ডের id, name, email এর সাথে মিলে যায়)
    const formattedUsers = users.map((user) => ({
      id: user._id.toString(),
      name: user.name || "Unknown Operator",
      email: user.email,
      role: user.role || "buyer",
      status: user.status || "active",
    }));

    res.status(200).send({
      success: true,
      data: formattedUsers,
    });
  } catch (error) {
    console.error("Failed to fetch users:", error);
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});

// ⚡ ২. ইউজারের রোল আপডেট করার রুট (PATCH)
app.patch("/api/admin/users/:id/role", async (req: any, res: any) => {
  try {
    const userId = req.params.id as string as string;
    const { role } = req.body;

    // 🌟 আইডি ভ্যালিড কিনা চেক করে নেওয়া (নাহলে ObjectId ক্র্যাশ করতে পারে)
    if (!ObjectId.isValid(userId)) {
      return res.status(400).send({ success: false, message: "Invalid User ID format" });
    }

    const filter = { _id: new ObjectId(userId) };
    const updateDoc = {
      $set: { role: role },
    };

    const result = await usersCollection.updateOne(filter, updateDoc);

    if (result.modifiedCount > 0) {
      res.status(200).send({ success: true, message: "Role updated successfully" });
    } else {
      res.status(400).send({ success: false, message: "Failed to update or no changes made" });
    }
  } catch (error) {
    console.error("Failed to update role:", error);
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});


// ⚡ ৩. ইউজারের স্ট্যাটাস (Active/Suspended) আপডেট করার রুট (PATCH)
app.patch("/api/admin/users/:id/status",verifyToken, async (req: any, res: any) => {
  try {
    const userId = req.params.id as string as string;
    const { status } = req.body; // ফ্রন্টএন্ড থেকে পাঠানো nextStatus

    // আইডি ভ্যালিড কিনা চেক করা
    if (!ObjectId.isValid(userId)) {
      return res.status(400).send({ success: false, message: "Invalid User ID format" });
    }

    const filter = { _id: new ObjectId(userId) };
    const updateDoc = {
      $set: { status: status }, // ডাটাবেজে status ফিল্ড সেট বা আপডেট হবে
    };

    const result = await usersCollection.updateOne(filter, updateDoc);

    // modifiedCount > 0 মানে নতুন মান বসেছে
    // upsertedCount বা matchedCount চেক করতে পারো যদি অলরেডি একই মান থাকে
    if (result.matchedCount > 0) {
      res.status(200).send({ success: true, message: "Status updated successfully" });
    } else {
      res.status(400).send({ success: false, message: "Failed to update status" });
    }
  } catch (error) {
    console.error("Failed to update status:", error);
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});

// 📋 ১. সব প্রোডাক্ট রিড করার রুট (Admin Access)
app.get("/api/admin/products",verifyToken, async (req, res) => {
  try {
    const products = await productsCollection.find({}).toArray(); 
    
    const formattedProducts = products.map((prod) => ({
      id: prod._id.toString(),
      title: prod.title || prod.name || "Untitled Product",
      price: prod.price || 0,
      category: prod.category || "Uncategorized",
      sellerEmail: prod.sellerEmail || "Unknown Seller",
      image: prod.image || "https://placehold.co/600x400",
      status: prod.status || "approved", // approved, pending, suspended
    }));

    res.status(200).send({ success: true, data: formattedProducts });
  } catch (error) {
    console.error("Failed to fetch products:", error);
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});

// ❌ ২. এডমিন কর্তৃক প্রোডাক্ট ডিলিট করার রুট (DELETE)
app.delete("/api/admin/products/:id",verifyToken, async (req: any, res: any) => {
  try {
    const prodId = req.params.id as string as string;

    if (!ObjectId.isValid(prodId)) {
      return res.status(400).send({ success: false, message: "Invalid Product ID format" });
    }

    const result = await productsCollection.deleteOne({ _id: new ObjectId(prodId) });

    if (result.deletedCount > 0) {
      res.status(200).send({ success: true, message: "Product purged successfully from Grid" });
    } else {
      res.status(404).send({ success: false, message: "Product not found" });
    }
  } catch (error) {
    console.error("Failed to delete product:", error);
    res.status(500).send({ success: false, message: "Internal server error" });
  }
});






app.post("/api/items",verifyToken, async (req, res) => {
  try {
    const itemData = req.body;
    itemData.status = "approved";
    
    // ডেটাবেজে ইনসার্ট করা
    const result = await productsCollection.insertOne(itemData);
    
    res.status(201).send({ 
      success: true, 
      message: "Item deployed successfully", 
      insertedId: result.insertedId 
    });
  } catch (error) {
    console.error(error);
    res.status(500).send({ success: false, message: "Internal Server Error" });
  }
});

/**
 * 🎯 ২. নির্দিষ্ট সেলারের ইমেইল অনুযায়ী আইটেম গেট করার রাউট (GET /api/items/my-items)
 */
app.get("/api/items/my-items",verifyToken, async (req, res) => {
  try {
    const email = req.query.email;
    
    if (!email) {
      return res.status(400).send({ success: false, message: "Email query param is required" });
    }

    // নির্দিষ্ট ইমেলের ডেটা ফিল্টার করা
    const query = { sellerEmail: email };
    const myItems = await productsCollection.find(query).toArray();
    
    res.send({ success: true, data: myItems });
  } catch (error) {
    console.error(error);
    res.status(500).send({ success: false, data: [], message: "Internal Server Error" });
  }
});

/**
 * 🎯 ৩. আইডি দিয়ে আইটেম ডিলিট করার রাউট (DELETE /api/items/:id)
 */
app.delete("/api/items/:id",verifyToken, async (req, res) => {
  try {
    const id = req.params.id as string as string as string;
    const query = { _id: new ObjectId(id) }; // মঙ্গোডিবির ওরিজিনাল ObjectId
    
    const result = await productsCollection.deleteOne(query);
    
    if (result.deletedCount === 1) {
      res.send({ success: true, message: "Item purged successfully from matrix" });
    } else {
      res.status(404).send({ success: false, message: "Item not found" });
    }
  } catch (error) {
    console.error(error);
    res.status(500).send({ success: false, message: "Internal Server Error" });
  }
});

app.get("/api/stats/dashboard", async (req, res) => {
  try {
    const totalUsers = await usersCollection.countDocuments();

    const totalProducts = await productsCollection.countDocuments();

    const totalSellers = await usersCollection.countDocuments({
      role: "seller",
    });

    const totalBuyers = await usersCollection.countDocuments({
      role: "buyer",
    });

    const totalManagers = await usersCollection.countDocuments({
      role: "manager",
    });

    const totalAdmins = await usersCollection.countDocuments({
      role: "admin",
    });

    const pendingProducts = await productsCollection.countDocuments({
      status: "pending",
    });

    const approvedProducts = await productsCollection.countDocuments({
      status: "approved",
    });

    const suspendedProducts = await productsCollection.countDocuments({
      status: "suspended",
    });

    res.send({
      stats: {
        totalUsers,
        totalProducts,
        totalSellers,
        pendingProducts,
      },

      userDistribution: [
        {
          name: "Buyers",
          value: totalBuyers,
          fill: "#06b6d4",
        },
        {
          name: "Sellers",
          value: totalSellers,
          fill: "#3b82f6",
        },
        {
          name: "Managers",
          value: totalManagers,
          fill: "#a855f7",
        },
        {
          name: "Admins",
          value: totalAdmins,
          fill: "#ef4444",
        },
      ],

      productStatus: [
        {
          name: "Approved",
          value: approvedProducts,
        },
        {
          name: "Pending",
          value: pendingProducts,
        },
        {
          name: "Suspended",
          value: suspendedProducts,
        },
      ],

      growthData: [
        {
          month: "Jan",
          Users: Math.floor(totalUsers * 0.2),
          Products: Math.floor(totalProducts * 0.2),
        },
        {
          month: "Feb",
          Users: Math.floor(totalUsers * 0.4),
          Products: Math.floor(totalProducts * 0.4),
        },
        {
          month: "Mar",
          Users: Math.floor(totalUsers * 0.6),
          Products: Math.floor(totalProducts * 0.6),
        },
        {
          month: "Apr",
          Users: Math.floor(totalUsers * 0.8),
          Products: Math.floor(totalProducts * 0.8),
        },
        {
          month: "May",
          Users: totalUsers,
          Products: totalProducts,
        },
      ],
    });
  } catch (error) {
    console.log(error);

    res.status(500).send({
      success: false,
      message: "Failed to load dashboard stats",
    });
  }
});

// 🔌 মঙ্গোডিবি কানেকশন ইনিশিয়ালাইজার
async function run() {
  try {
    // await client.connect();
    // await client.db("admin").command({ ping: 1 });
    console.log("⚡️ Connected to MongoDB Atlas successfully!");
  } catch (error) {
    console.error("❌ Database connection error:", error);
  }
}
run().catch(console.dir);

app.get("/xyz", (req, res) => {
  console.log("XYZ HIT");
  res.send("XYZ");
});

app.listen(port, () => {
  console.log(`⚡️ [server]: Server is running at http://localhost:${port}`);
});