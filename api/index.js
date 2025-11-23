import express from "express";
import cors from "cors";
import { google } from "googleapis";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { config } from "dotenv";
import * as process from "process";
import crypto from "crypto";
import { Buffer } from "buffer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: "./.env" });

const app = express();

// Middleware
app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  })
);
app.use(express.json());

// Serve static files in production
// if (process.env.NODE_ENV === "production") {
//   app.use(express.static(join(__dirname, "dist")));

//   // Handle client-side routing
//   app.get("*", (req, res) => {
//     res.sendFile(join(__dirname, "dist", "index.html"));
//   });
// }

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
      range: "Sheet1!A3:AI", // Skip header row, get only data rows
    });

    const rows = response.data.values || [];
    const products = rows.map((row) => ({
      id: row[0],
      name: row[1],
      description: row[2],
      price: parseFloat(row[12]),
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
      range: "OrderLinks!A:E",
    });

    const linkRows = linkResponse.data.values || [];
    const orderLinks = linkRows.filter((row) => row[0] === linkId);

    const paymentStatus =
      orderLinks.length > 0
        ? orderLinks[0][4] || "pending"
        : orderLinks[4] | "pending";

    if (orderLinks.length === 0) {
      return res.status(404).json({
        success: false,
        message: "Order link not found",
      });
    }

    // Get all products details
    const productResponse = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.PRODUCTS_SHEET_ID,
      range: "Sheet1!A3:AI", // Skip header row, get only data rows
    });

    const productRows = productResponse.data.values || [];
    const productsMap = new Map(
      productRows.map((row) => [
        row[0],
        {
          id: row[0],
          name: row[1],
          description: row[2],
          price: parseFloat(row[12]),
          SKU: row[31],
          weight: row[22],
          length: row[33],
          breadth: row[34],
          height: row[32],
          colors: row[30],
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
        paymentStatus,
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
      range: "Sheet1!A3:AI", // Skip header row, get only data rows
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
      price: parseFloat(product[12]),
      SKU: product[31],
      weight: product[22],
      length: product[33],
      breadth: product[34],
      height: product[32],
      colors: product[30],
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
      quantity,
      totalAmount,
      paymentId,
      timestamp,
      orderId,
      shippingAddressLine1,
      shippingAddressLine2,
      shippingCity,
      shippingState,
      shippingPincode,
      billingAddressLine1,
      billingAddressLine2,
      billingCity,
      billingState,
      billingPincode,
      email,
      productName,
      unitPrice,
      SKU,
      PaymentMethod,
      COD,
      weightOfShipment,
      lengthOfShipment,
      breadthOfShipment,
      heightOfShipment,
      products,
      isThisMultipleProductOrder,
      customizationDetails,
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
    let productRows = [];

    
    const pickUpCode = "13556454"; // Hardcoded pickup code
    const country = "India"; // Hardcoded country
    // const couriedId = "1"; // Hardcoded courier ID
    products?.length > 0 && products.forEach(product => {
      productRows.push([
                    orderId,
            pickUpCode,
            phoneNumber,
            firstName,
            lastName,
            email,
            shippingAddressLine1,
            shippingAddressLine2,
            shippingPincode,
            shippingCity,
            shippingState,
            country,
            billingAddressLine1,
            billingAddressLine2,
            billingPincode,
            billingCity,
            billingState,
            country,
            product.name,
            product.price,
            product.quantity,
            product.SKU,
            PaymentMethod,
            COD,
            totalAmount,
            product.weight,
            product.length,
            product.breadth,
            product.height,
            "", // Courier Name (not provided)
            paymentId,
            isThisMultipleProductOrder,
            timestamp,
          ]);
        });

    // Append data to Google Sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "Sheet1!A:AF", // Update this range according to your sheet
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [
          // [
          //   orderId,
          //   pickUpCode,
          //   phoneNumber,
          //   firstName,
          //   lastName,
          //   email,
          //   shippingAddressLine1,
          //   shippingAddressLine2,
          //   shippingPincode,
          //   shippingCity,
          //   shippingState,
          //   country,
          //   billingAddressLine1,
          //   billingAddressLine2,
          //   billingPincode,
          //   billingCity,
          //   billingState,
          //   country,
          //   productName,
          //   unitPrice,
          //   quantity,
          //   SKU,
          //   PaymentMethod,
          //   COD,
          //   totalAmount,
          //   weightOfShipment,
          //   lengthOfShipment,
          //   breadthOfShipment,
          //   heightOfShipment,
          //   "", // Courier Name (not provided)
          //   paymentId,
          //   isThisMultipleProductOrder,
          //   timestamp,
          // ],
          ...productRows,
        ],
      },
    });

    if (Object.keys(customizationDetails).length > 0) {
      // Append customization details to a separate sheet
      Object.keys(customizationDetails).forEach(async (key) => {
        const details = customizationDetails[key];
        // details.forEach(async (detail) => {
        await sheets.spreadsheets.values.append({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: `Custom-${key}!A:Z`, // Update this range according to your sheet
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [...details],
          },
        });
        // });
      });
    }

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

app.put("/api/update-payment-status", async (req, res) => {
  try {
    const { linkId, paymentStatus } = req.body;

    if (!linkId || !paymentStatus) {
      return res.status(400).json({
        success: false,
        message: "linkId and paymentStatus are required",
      });
    }
    // Get all order links
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.ORDER_LINKS_SHEET_ID,
      range: "OrderLinks!A:E",
    });
    const rows = response.data.values || [];

    // Find rows with the given linkId and update payment status
    const updatedRows = rows.map((row) => {
      if (row[0] === linkId) {
        row[4] = paymentStatus; // Assuming payment status is in column E (index 4)
      }
      return row;
    });

    // Clear existing data
    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.ORDER_LINKS_SHEET_ID,
      range: "OrderLinks!A:E",
    });

    // Write updated data back to the sheet
    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.ORDER_LINKS_SHEET_ID,
      range: "OrderLinks!A:E",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: updatedRows,
      },
    });
    res.json({
      success: true,
      message: "Payment status updated successfully",
    });
  } catch (error) {
    console.error("Error updating payment status:", error);
    res.status(500).json({
      success: false,
      message: "Error updating payment status",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

app.get("/api/order/:orderId", async (req, res) => {
  try {
    const { orderId } = req.params;

    console.log("Fetching order details for orderId:", orderId);

    // Get order data from the main orders sheet
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "Sheet1!A:AF",
    });

    const rows = response.data.values || [];

    // Find the order with matching orderId (assuming orderId is in first column)
    const orderRow = rows.find((row) => row[0] === orderId);

    if (!orderRow) {
      return res.status(404).json({
        success: false,
        message: "Order not found",
      });
    }

    // Map the row data to order object
    const orderData = {
      orderId: orderRow[0],
      pickUpCode: orderRow[1],
      phoneNumber: orderRow[2],
      firstName: orderRow[3],
      lastName: orderRow[4],
      email: orderRow[5],
      shippingAddress: {
        addressLine1: orderRow[6],
        addressLine2: orderRow[7],
        pincode: orderRow[8],
        city: orderRow[9],
        state: orderRow[10],
        country: orderRow[11],
      },
      billingAddress: {
        addressLine1: orderRow[12],
        addressLine2: orderRow[13],
        pincode: orderRow[14],
        city: orderRow[15],
        state: orderRow[16],
        country: orderRow[17],
      },
      product: {
        name: orderRow[18],
        unitPrice: parseFloat(orderRow[19]) || 0,
        quantity: parseInt(orderRow[20]) || 0,
        SKU: orderRow[21],
      },
      payment: {
        method: orderRow[22],
        COD: orderRow[23],
        totalAmount: parseFloat(orderRow[24]) || 0,
        paymentId: orderRow[30],
      },
      shipping: {
        weight: parseFloat(orderRow[25]) || 0,
        dimensions: {
          length: parseFloat(orderRow[26]) || 0,
          breadth: parseFloat(orderRow[27]) || 0,
          height: parseFloat(orderRow[28]) || 0,
        },
        courierId: orderRow[29],
      },
      isMultipleProductOrder: orderRow[31],
      timestamp: orderRow[32],
    };

    res.json({
      success: true,
      data: orderData,
    });
  } catch (error) {
    console.error("Error fetching order details:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching order details",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});
// Start the server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

export default app;
