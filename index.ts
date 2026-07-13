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
    const productId = req.params.id;
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
    const productId = req.params.id;
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
    const productId = req.params.id;
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
app.get("/api/products/:id", async (req: Request, res: Response) => {
  try {
    const { id } = req.params;

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

// 🔌 মঙ্গোডিবি কানেকশন ইনিশিয়ালাইজার
async function run() {
  try {
    await client.connect();
    await client.db("admin").command({ ping: 1 });
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