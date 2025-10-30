import express from "express";
import cors from "cors";
import { google } from "googleapis";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { config } from "dotenv";
import * as process from "process";
import crypto from "crypto";
import { Buffer } from "buffer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: "./.env" });

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Serve static files in production
if (process.env.NODE_ENV === "production") {
  app.use(express.static(join(__dirname, "dist")));

  // Handle client-side routing
  app.get("*", (req, res) => {
    res.sendFile(join(__dirname, "dist", "index.html"));
  });
}

// Authentication middleware
const authenticateAdmin = (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({
      success: false,
      message: "No authentication token provided",
    });
  }

  const token = authHeader.split(" ")[1];

  try {
    // In a production environment, you should use JWT or a proper session management system
    const [username, password] = Buffer.from(token, "base64")
      .toString()
      .split(":");

    if (
      username === process.env.ADMIN_USERNAME &&
      password === process.env.ADMIN_PASSWORD
    ) {
      next();
    } else {
      res.status(401).json({
        success: false,
        message: "Invalid credentials",
      });
    }
  } catch (error) {
    res.status(401).json({
      success: false,
      message: "Invalid authentication token",
    });
  }
};

// Configure Google Sheets
if (
  !process.env.GOOGLE_SHEETS_CLIENT_EMAIL ||
  !process.env.GOOGLE_SHEETS_PRIVATE_KEY
) {
  console.error("Missing required Google Sheets credentials in .env file");
  process.exit(1);
}

const auth = new google.auth.GoogleAuth({
  credentials: {
    type: "service_account",
    project_id: "whatsapp-checkout",
    private_key: process.env.GOOGLE_SHEETS_PRIVATE_KEY.replace(/\\n/g, "\n"),
    client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
    universe_domain: "googleapis.com",
  },
  scopes: ["https://www.googleapis.com/auth/spreadsheets"],
});

const sheets = google.sheets({ version: "v4", auth });

// Admin login endpoint
app.post("/api/admin/login", async (req, res) => {
  const { username, password } = req.body;

  if (
    username === process.env.ADMIN_USERNAME &&
    password === process.env.ADMIN_PASSWORD
  ) {
    // In production, use JWT or proper session management
    const token = Buffer.from(`${username}:${password}`).toString("base64");
    res.json({
      success: true,
      token,
    });
  } else {
    res.status(401).json({
      success: false,
      message: "Invalid credentials",
    });
  }
});

// Get all products endpoint
app.get("/api/products", authenticateAdmin, async (req, res) => {
  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.PRODUCTS_SHEET_ID,
      range: "Sheet1!A2:D",
    });

    const rows = response.data.values || [];
    const products = rows.map((row) => ({
      id: row[0],
      name: row[1],
      description: row[2],
      price: parseFloat(row[3]),
    }));

    res.json({
      success: true,
      data: products,
    });
  } catch (error) {
    console.error("Error fetching products:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching products",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Helper function to generate a unique link ID
const generateLinkId = () => {
  return crypto.randomBytes(8).toString("hex");
};

// API Routes
app.post("/api/generate-link", async (req, res) => {
  try {
    const { products } = req.body;

    if (!products || !Array.isArray(products) || products.length === 0) {
      return res.status(400).json({
        success: false,
        message: "At least one product is required",
      });
    }

    // Generate a unique link ID
    const linkId = generateLinkId();
    const timestamp = new Date().toISOString();

    // First check if OrderLinks sheet exists, if not create it
    try {
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: process.env.ORDER_LINKS_SHEET_ID,
      });

      const orderLinksSheet = spreadsheet.data.sheets.find(
        (sheet) => sheet.properties.title === "OrderLinks"
      );

      if (!orderLinksSheet) {
        // Create OrderLinks sheet with headers
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: process.env.ORDER_LINKS_SHEET_ID,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: "OrderLinks",
                  },
                },
              },
            ],
          },
        });

        // Add headers
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.ORDER_LINKS_SHEET_ID,
          range: "OrderLinks!A1:D1",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [["Link ID", "Product ID", "Quantity", "Timestamp"]],
          },
        });
      }
    } catch (error) {
      console.error("Error checking/creating OrderLinks sheet:", error);
      throw new Error("Failed to setup OrderLinks sheet");
    }

    // Save each product to order links sheet
    const rows = products.map(({ productId, quantity }) => [
      linkId,
      productId,
      quantity,
      timestamp,
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.ORDER_LINKS_SHEET_ID,
      range: "OrderLinks!A:D",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: rows,
      },
    });

    res.json({
      success: true,
      linkId,
      message: "Link generated successfully",
    });
  } catch (error) {
    console.error("Error generating link:", error);
    res.status(500).json({
      success: false,
      message: "Error generating link",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/order-link/:linkId", async (req, res) => {
  try {
    const { linkId } = req.params;

    // Get order link details
    const linkResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.ORDER_LINKS_SHEET_ID,
      range: "OrderLinks!A:D",
    });

    const linkRows = linkResponse.data.values || [];
    const orderLinks = linkRows.filter((row) => row[0] === linkId);

    if (orderLinks.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order link not found",
      });
    }

    // Get all products details
    const productResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.PRODUCTS_SHEET_ID,
      range: "Sheet1!A2:D",
    });

    const productRows = productResponse.data.values || [];
    const productsMap = new Map(
      productRows.map((row) => [
        row[0],
        {
          id: row[0],
          name: row[1],
          description: row[2],
          price: parseFloat(row[3]),
        },
      ])
    );

    // Combine order and product details
    const orderProducts = orderLinks.map((link) => {
      const [_, productId, quantity] = link;
      const product = productsMap.get(productId);

      if (!product) {
        throw new Error(`Product not found: ${productId}`);
      }

      return {
        ...product,
        quantity: parseInt(quantity),
      };
    });

    // Calculate total amount
    const totalAmount = orderProducts.reduce(
      (sum, item) => sum + item.price * item.quantity,
      0
    );

    res.json({
      success: true,
      data: {
        linkId,
        products: orderProducts,
        totalAmount,
      },
    });
  } catch (error) {
    console.error("Error fetching order link details:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching order details",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/product/:productId", async (req, res) => {
  try {
    const { productId } = req.params;

    console.log(
      "Fetching product data from spreadsheet:",
      process.env.PRODUCTS_SHEET_ID
    );

    // First, get the sheet information to verify it exists
    const spreadsheet = await sheets.spreadsheets.get({
      spreadsheetId: process.env.PRODUCTS_SHEET_ID,
    });

    // Log available sheets
    console.log(
      "Available sheets:",
      spreadsheet.data.sheets.map((sheet) => sheet.properties.title)
    );

    // Get product data from the products sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.PRODUCTS_SHEET_ID,
      range: "Sheet1!A2:D", // Skip header row, get only data rows
    });

    const rows = response.data.values || [];
    // Find the product with matching ID
    const product = rows.find((row) => row[0] === productId); // Assuming product ID is in first column

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    // Assuming columns are: ID, Name, Description, Price
    const productData = {
      id: product[0],
      name: product[1],
      description: product[2],
      price: parseFloat(product[3]),
    };

    res.json({
      success: true,
      data: productData,
    });
  } catch (error) {
    console.error("Error fetching product data:", error);

    // More detailed error message
    let errorMessage = "Error fetching product data";
    if (error.message.includes("Unable to parse range")) {
      errorMessage =
        "Sheet configuration error. Please verify the sheet name and column range.";
    } else if (error.message.includes("Requested entity was not found")) {
      errorMessage =
        "Spreadsheet not found. Please verify the PRODUCTS_SHEET_ID in .env file.";
    } else if (error.message.includes("The caller does not have permission")) {
      errorMessage =
        "Access denied. Please share the spreadsheet with the service account email.";
    }

    res.status(500).json({
      success: false,
      message: errorMessage,
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
app.post("/api/saveToSheet", async (req, res) => {
  try {
    const {
      phoneNumber,
      firstName,
      lastName,
      address,
      quantity,
      totalAmount,
      paymentId,
      timestamp,
    } = req.body;

    console.log("Attempting to save data with credentials:", {
      client_email: process.env.GOOGLE_SHEETS_CLIENT_EMAIL,
      spreadsheet_id: process.env.GOOGLE_SHEETS_ID,
    });

    // First, try to get the spreadsheet info to verify permissions
    try {
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      });
      console.log(
        "Successfully accessed spreadsheet:",
        spreadsheet.data.properties.title
      );
    } catch (sheetError) {
      console.error("Error accessing spreadsheet:", sheetError);
      throw new Error(
        "Failed to access spreadsheet. Please verify sharing permissions."
      );
    }

    // Append data to Google Sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "Sheet1!A:H", // Update this range according to your sheet
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          [
            phoneNumber,
            firstName,
            lastName,
            address,
            quantity,
            totalAmount,
            paymentId,
            timestamp,
          ],
        ],
      },
    });

    res.json({ success: true, message: "Data saved successfully" });
  } catch (error) {
    console.error("Error saving to Google Sheets:", error);
    res.status(500).json({
      success: false,
      message: "Error saving data",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
