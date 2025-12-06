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
    const { products, isCustomOrder = false } = req.body;

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
          range: "OrderLinks!A1:F1",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: [
              [
                "Link ID",
                "Product ID",
                "Quantity",
                "Timestamp",
                "Payment Status",
                "Is Custom Order",
              ],
            ],
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
      "",
      isCustomOrder ? 1 : 0,
    ]);

    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.ORDER_LINKS_SHEET_ID,
      range: "OrderLinks!A:F",
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
      range: "OrderLinks!A:F",
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
    const isCustomOrder =
      orderLinks?.length > 0 ? orderLinks[0][5] == "1" : orderLinks[5] == "1";
    if (isCustomOrder) {
      const customOrderResponse = await sheets.spreadsheets.values.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
        range: "Custom-Orders!A:Q",
      });
      const productId =
        orderLinks.length > 0 ? orderLinks[0][1] : orderLinks[1];

      const customOrderRows = customOrderResponse.data.values || [];
      const customOrderDetails = customOrderRows.filter(
        (row) => row[0] === productId
      );
      return res.json({
        success: true,
        data: {
          linkId,
          customOrderDetails: customOrderDetails,
          paymentStatus,
        },
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
    products?.length > 0 &&
      products.forEach((product) => {
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
          product.weight?.split(" ")[0],
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
        values: [...productRows],
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

// Save custom order details
app.post("/api/saveCustomOrderDetails", async (req, res) => {
  try {
    const {
      modelId,
      material,
      infill,
      layerHeight,
      modelUrl,
      volume_cm3,
      dims_cm,
      supportsNeeded,
      printTime,
      materialCost,
      serviceCharge,
      totalCost,
      referrer,
      customizationOptions,
      customNotes,
      specialRequirements,
      timestamp,
    } = req.body;

    if (!modelId) {
      return res.status(400).json({
        success: false,
        message: "modelId is required",
      });
    }

    // Check if CustomOrderDetails sheet exists and has headers
    try {
      const spreadsheet = await sheets.spreadsheets.get({
        spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      });

      const customOrderDetailsSheet = spreadsheet.data.sheets.find(
        (sheet) => sheet.properties.title === "CustomOrderDetails"
      );

      if (!customOrderDetailsSheet) {
        // Create CustomOrderDetails sheet with headers
        console.log("CustomOrderDetails sheet not found. Creating it...");
        await sheets.spreadsheets.batchUpdate({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          requestBody: {
            requests: [
              {
                addSheet: {
                  properties: {
                    title: "CustomOrderDetails",
                  },
                },
              },
            ],
          },
        });

        // Add headers
        const headers = [
          [
            "Model ID",
            "Material",
            "Infill",
            "Layer Height",
            "Model URL",
            "Volume (cm³)",
            "Dimensions (cm)",
            "Supports Needed",
            "Print Time",
            "Material Cost",
            "Service Charge",
            "Total Cost",
            "Referrer",
            "Customization Options",
            "Custom Notes",
            "Special Requirements",
            "Timestamp",
          ],
        ];

        await sheets.spreadsheets.values.update({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: "CustomOrderDetails!A1:Q1",
          valueInputOption: "USER_ENTERED",
          requestBody: {
            values: headers,
          },
        });

        console.log("CustomOrderDetails sheet created with headers.");
      } else {
        // Check if sheet has headers
        const headerResponse = await sheets.spreadsheets.values.get({
          spreadsheetId: process.env.GOOGLE_SHEETS_ID,
          range: "CustomOrderDetails!A1:Q1",
        });

        const existingHeaders = headerResponse.data.values || [];

        if (existingHeaders.length === 0) {
          // Add headers if they don't exist
          console.log(
            "No headers found in CustomOrderDetails sheet. Adding headers..."
          );
          const headers = [
            [
              "Model ID",
              "Material",
              "Infill",
              "Layer Height",
              "Model URL",
              "Volume (cm³)",
              "Dimensions (cm)",
              "Supports Needed",
              "Print Time",
              "Material Cost",
              "Service Charge",
              "Total Cost",
              "Referrer",
              "Customization Options",
              "Custom Notes",
              "Special Requirements",
              "Timestamp",
            ],
          ];

          await sheets.spreadsheets.values.update({
            spreadsheetId: process.env.GOOGLE_SHEETS_ID,
            range: "CustomOrderDetails!A1:Q1",
            valueInputOption: "USER_ENTERED",
            requestBody: {
              values: headers,
            },
          });

          console.log("Headers added to CustomOrderDetails sheet.");
        }
      }
    } catch (sheetSetupError) {
      console.error(
        "Error setting up CustomOrderDetails sheet:",
        sheetSetupError
      );
      throw new Error("Failed to setup CustomOrderDetails sheet");
    }

    // Prepare custom details row with 3D printing specifications
    const customDetailsRow = [
      modelId,
      material || "",
      infill || "",
      layerHeight || "",
      modelUrl || "",
      volume_cm3 || "",
      JSON.stringify(dims_cm || {}),
      supportsNeeded || "",
      printTime || "",
      materialCost || "",
      serviceCharge || "",
      totalCost || "",
      referrer || "",
      JSON.stringify(customizationOptions || {}),
      customNotes || "",
      specialRequirements || "",
      timestamp || new Date().toISOString(),
    ];

    // Append to custom order details sheet
    await sheets.spreadsheets.values.append({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "CustomOrderDetails!A:Q",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: [customDetailsRow],
      },
    });

    res.json({
      success: true,
      message: "Custom order details saved successfully",
      modelId,
    });
  } catch (error) {
    console.error("Error saving custom order details:", error);

    // Check if sheet exists error
    if (error.message.includes("Unable to parse range")) {
      return res.status(500).json({
        success: false,
        message: "CustomOrderDetails sheet not found. Please create it first.",
        error: error instanceof Error ? error.message : "Unknown error",
      });
    }

    res.status(500).json({
      success: false,
      message: "Error saving custom order details",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Get custom order details
app.get("/api/customOrderDetails/:modelId", async (req, res) => {
  try {
    const { modelId } = req.params;

    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "CustomOrderDetails!A:Q",
    });

    const rows = response.data.values || [];
    const customDetails = rows.find((row) => row[0] === modelId);

    if (!customDetails) {
      return res.status(404).json({
        success: false,
        message: "Custom order details not found",
      });
    }

    const customDetailsData = {
      modelId: customDetails[0],
      material: customDetails[1] || "",
      infill: customDetails[2] || "",
      layerHeight: customDetails[3] || "",
      modelUrl: customDetails[4] || "",
      volume_cm3: customDetails[5] || "",
      dims_cm: JSON.parse(customDetails[6] || "{}"),
      supportsNeeded: customDetails[7] || "",
      printTime: customDetails[8] || "",
      materialCost: customDetails[9] || "",
      serviceCharge: customDetails[10] || "",
      totalCost: customDetails[11] || "",
      referrer: customDetails[12] || "",
      customizationOptions: JSON.parse(customDetails[13] || "{}"),
      customNotes: customDetails[14] || "",
      specialRequirements: customDetails[15] || "",
      timestamp: customDetails[16],
    };

    res.json({
      success: true,
      data: customDetailsData,
    });
  } catch (error) {
    console.error("Error fetching custom order details:", error);
    res.status(500).json({
      success: false,
      message: "Error fetching custom order details",
      error: error instanceof Error ? error.message : "Unknown error",
    });
  }
});

// Update custom order details
app.put("/api/updateCustomOrderDetails/:modelId", async (req, res) => {
  try {
    const { modelId } = req.params;
    const {
      material,
      infill,
      layerHeight,
      modelUrl,
      volume_cm3,
      dims_cm,
      supportsNeeded,
      printTime,
      materialCost,
      serviceCharge,
      totalCost,
      referrer,
      customizationOptions,
      customNotes,
      specialRequirements,
    } = req.body;

    // Get all custom order details
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "CustomOrderDetails!A:Q",
    });

    const rows = response.data.values || [];
    let rowIndex = -1;

    // Find the row with the matching modelId
    const updatedRows = rows.map((row, index) => {
      if (row[0] === modelId) {
        rowIndex = index;
        return [
          modelId,
          material || row[1] || "",
          infill || row[2] || "",
          layerHeight || row[3] || "",
          modelUrl || row[4] || "",
          volume_cm3 || row[5] || "",
          JSON.stringify(dims_cm || JSON.parse(row[6] || "{}")),
          supportsNeeded || row[7] || "",
          printTime || row[8] || "",
          materialCost || row[9] || "",
          serviceCharge || row[10] || "",
          totalCost || row[11] || "",
          referrer || row[12] || "",
          JSON.stringify(customizationOptions || JSON.parse(row[13] || "{}")),
          customNotes || row[14] || "",
          specialRequirements || row[15] || "",
          new Date().toISOString(),
        ];
      }
      return row;
    });

    if (rowIndex === -1) {
      return res.status(404).json({
        success: false,
        message: "Custom order details not found",
      });
    }

    // Clear and rewrite the data
    await sheets.spreadsheets.values.clear({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "CustomOrderDetails!A:Q",
    });

    await sheets.spreadsheets.values.update({
      spreadsheetId: process.env.GOOGLE_SHEETS_ID,
      range: "CustomOrderDetails!A:Q",
      valueInputOption: "USER_ENTERED",
      requestBody: {
        values: updatedRows,
      },
    });

    res.json({
      success: true,
      message: "Custom order details updated successfully",
      modelId,
    });
  } catch (error) {
    console.error("Error updating custom order details:", error);
    res.status(500).json({
      success: false,
      message: "Error updating custom order details",
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
