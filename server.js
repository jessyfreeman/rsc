
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const fs = require("fs");
const path = require("path");
const Tesseract = require("tesseract.js");

const app = express();
const PORT = process.env.PORT || 3000;

// ============================================
// MIDDLEWARE
// ============================================

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const publicFolder = path.join(__dirname, "public");
const dataFolder = path.join(__dirname, "data");
const uploadFolder = path.join(__dirname, "uploads");

fs.mkdirSync(dataFolder, { recursive: true });
fs.mkdirSync(uploadFolder, { recursive: true });

app.use(express.static(publicFolder));

// ============================================
// JSON DATA FILES
// ============================================

const productsFile = path.join(dataFolder, "products.json");
const scansFile = path.join(dataFolder, "scans.json");

function initializeFile(file) {
    if (!fs.existsSync(file)) {
        fs.writeFileSync(file, "[]", "utf8");
    }
}

initializeFile(productsFile);
initializeFile(scansFile);

function readData(file) {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));

    if (!Array.isArray(data)) {
        throw new Error("Invalid JSON data in " + path.basename(file));
    }

    return data;
}

function writeData(file, data) {
    fs.writeFileSync(file, JSON.stringify(data, null, 2), "utf8");
}

function getProducts() {
    return readData(productsFile);
}

function saveProducts(data) {
    writeData(productsFile, data);
}

function getScans() {
    return readData(scansFile);
}

function saveScans(data) {
    writeData(scansFile, data);
}

function makeId(records) {
    const largest = records.reduce(function (max, item) {
        return Math.max(max, Number(item.id) || 0);
    }, 0);

    return Math.max(Date.now(), largest + 1);
}

// ============================================
// DATE AND PRODUCT VALIDATION
// ============================================

function isValidDate(value) {
    if (typeof value !== "string") return false;

    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
        return false;
    }

    const date = new Date(value + "T00:00:00.000Z");

    return (
        !Number.isNaN(date.getTime()) &&
        date.toISOString().slice(0, 10) === value
    );
}

function isExpired(value) {
    if (!isValidDate(value)) return false;

    const today = new Date().toISOString().slice(0, 10);

    return value < today;
}

function validateProduct(body) {
    const sku = String(body.sku || "").trim();
    const name = String(body.name || "").trim();
    const barcode = String(body.barcode || "").trim();
    const currency = String(body.currency || "UGX").trim();
    const price = Number(body.approved_price);
    const expiryDate = String(body.expiry_date || "").trim();

    if (!sku || !name) {
        return { error: "SKU and product name are required." };
    }

    if (
        body.approved_price === undefined ||
        String(body.approved_price).trim() === "" ||
        !Number.isFinite(price) ||
        price < 0
    ) {
        return { error: "Enter a valid approved price." };
    }

    if (!expiryDate || !isValidDate(expiryDate)) {
        return {
            error: "Enter a valid expiry date in YYYY-MM-DD format."
        };
    }

    return {
        value: {
            sku,
            name,
            barcode,
            currency,
            approved_price: price,
            expiry_date: expiryDate
        }
    };
}

// ============================================
// IMAGE UPLOAD
// Accepts both "image" and "shelfImage"
// ============================================

const storage = multer.diskStorage({
    destination: function (req, file, callback) {
        callback(null, uploadFolder);
    },

    filename: function (req, file, callback) {
        const extension = path.extname(file.originalname).toLowerCase();

        callback(
            null,
            Date.now() + "-" +
            Math.round(Math.random() * 1000000) + extension
        );
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 10 * 1024 * 1024
    },
    fileFilter: function (req, file, callback) {
        const allowedTypes = [
            "image/jpeg",
            "image/png",
            "image/webp",
            "image/bmp",
            "image/tiff"
        ];

        if (!allowedTypes.includes(file.mimetype)) {
            return callback(
                new Error("Upload a JPG, PNG, WEBP, BMP or TIFF image.")
            );
        }

        callback(null, true);
    }
});

const imageFields = upload.fields([
    { name: "image", maxCount: 1 },
    { name: "shelfImage", maxCount: 1 }
]);

// ============================================
// OCR TEXT EXTRACTION
// ============================================

async function extractImageText(imagePath) {
    const result = await Tesseract.recognize(imagePath, "eng");
    return result.data.text || "";
}

// Normalize text for comparing product names.
function normalizeText(value) {
    return String(value || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "");
}

// ============================================
// FIND PRODUCT FROM OCR TEXT
// ============================================

function matchProduct(ocrText, products, suppliedSku, suppliedBarcode) {
    const text = normalizeText(ocrText);
    const sku = String(suppliedSku || "").trim();
    const barcode = String(suppliedBarcode || "").trim();

    // Explicit staff-provided identifiers take priority.
    if (sku) {
        const bySku = products.find(function (product) {
            return String(product.sku).toLowerCase() === sku.toLowerCase();
        });

        if (bySku) return bySku;
    }

    if (barcode) {
        const byBarcode = products.find(function (product) {
            return String(product.barcode || "") === barcode;
        });

        if (byBarcode) return byBarcode;
    }

    // Match exact SKU or barcode found in the OCR text.
    const byIdentifier = products.find(function (product) {
        const productSku = normalizeText(product.sku);
        const productBarcode = normalizeText(product.barcode);

        return (
            (productSku && text.includes(productSku)) ||
            (productBarcode && text.includes(productBarcode))
        );
    });

    if (byIdentifier) return byIdentifier;

    // Product-name matching is approximate only in the sense that
    // punctuation and spaces are removed. It is not AI vision matching.
    const byName = products.find(function (product) {
        const name = normalizeText(product.name);

        return name.length >= 4 && text.includes(name);
    });

    return byName || null;
}

// ============================================
// EXTRACT EXPIRY DATE FROM OCR
// Supports YYYY-MM-DD, DD/MM/YYYY, DD-MM-YYYY
// and DD.MM.YYYY
// ============================================

function extractExpiryDate(text) {
    const lines = text.split(/\r?\n/);

    // Prefer lines containing expiry-related labels.
    const labelledLines = lines.filter(function (line) {
        return /\b(exp|expiry|expires|expiration|use by|best before)\b/i
            .test(line);
    });

    const candidates = [
        ...labelledLines,
        text
    ];

    for (const line of candidates) {
        const iso = line.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);

        if (iso) {
            const value = [
                iso[1],
                iso[2].padStart(2, "0"),
                iso[3].padStart(2, "0")
            ].join("-");

            if (isValidDate(value)) return value;
        }

        const other = line.match(
            /\b(\d{1,2})[\/.-](\d{1,2})[\/.-](20\d{2})\b/
        );

        if (other) {
            const value = [
                other[3],
                other[2].padStart(2, "0"),
                other[1].padStart(2, "0")
            ].join("-");

            if (isValidDate(value)) return value;
        }
    }

    return null;
}

// ============================================
// EXTRACT PRICE FROM OCR
// Price detection is heuristic and needs review.
// ============================================

function extractShelfPrice(text, manuallySuppliedPrice) {
    if (
        manuallySuppliedPrice !== undefined &&
        String(manuallySuppliedPrice).trim() !== ""
    ) {
        const price = Number(manuallySuppliedPrice);

        if (Number.isFinite(price) && price >= 0) {
            return price;
        }

        return null;
    }

    const lines = text.split(/\r?\n/);

    const priceLines = lines.filter(function (line) {
        return /\b(price|ugx|shs|shillings|cost)\b|[=:]/i.test(line);
    });

    for (const line of priceLines) {
        // Ignore date-shaped text to reduce false price readings.
        if (/\b\d{1,4}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/.test(line)) {
            continue;
        }

        const matches = [
            ...line.matchAll(/(?:UGX|USh|Shs?\.?)?\s*([\d,]+(?:\.\d{1,2})?)/gi)
        ];

        for (const match of matches) {
            const raw = match[1].replace(/,/g, "");
            const value = Number(raw);

            if (
                Number.isFinite(value) &&
                value >= 0 &&
                value <= 100000000
            ) {
                return value;
            }
        }
    }

    // Do not guess a price from unrelated numbers such as barcodes.
    return null;
}

// ============================================
// HOME PAGE
// ============================================

app.get("/", function (req, res) {
    const file = path.join(publicFolder, "home.html");

    if (fs.existsSync(file)) {
        return res.sendFile(file);
    }

    res.send(`
        <h1>Retail Compliance Scanner</h1>
        <p>Server is running.</p>
        <a href="/api/health">Check API</a>
    `);
});

// ============================================
// HEALTH CHECK
// ============================================

app.get("/api/health", function (req, res) {
    res.json({
        success: true,
        message: "Retail Compliance Scanner API is running.",
        time: new Date().toISOString(),
        ocr: "Tesseract.js enabled"
    });
});

// ============================================
// GET PRODUCTS
// ============================================

app.get("/api/products", function (req, res) {
    try {
        const products = getProducts();

        res.json({
            success: true,
            count: products.length,
            products
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Could not load products."
        });
    }
});

// ============================================
// ADD PRODUCT
// ============================================

app.post("/api/products", function (req, res) {
    try {
        const validation = validateProduct(req.body);

        if (validation.error) {
            return res.status(400).json({
                success: false,
                message: validation.error
            });
        }

        const products = getProducts();
        const data = validation.value;

        const duplicate = products.find(function (product) {
            return String(product.sku).toLowerCase() ===
                data.sku.toLowerCase();
        });

        if (duplicate) {
            return res.status(409).json({
                success: false,
                message: "This SKU already exists."
            });
        }

        const product = {
            id: makeId(products),
            ...data,
            created_at: new Date().toISOString()
        };

        products.push(product);
        saveProducts(products);

        res.status(201).json({
            success: true,
            message: "Product added successfully.",
            product
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Could not add product."
        });
    }
});

// ============================================
// UPDATE PRODUCT
// ============================================

app.put("/api/products/:id", function (req, res) {
    try {
        const products = getProducts();
        const id = Number(req.params.id);

        const index = products.findIndex(function (product) {
            return Number(product.id) === id;
        });

        if (index === -1) {
            return res.status(404).json({
                success: false,
                message: "Product not found."
            });
        }

        const validation = validateProduct(req.body);

        if (validation.error) {
            return res.status(400).json({
                success: false,
                message: validation.error
            });
        }

        const data = validation.value;

        const duplicate = products.find(function (product) {
            return (
                Number(product.id) !== id &&
                String(product.sku).toLowerCase() === data.sku.toLowerCase()
            );
        });

        if (duplicate) {
            return res.status(409).json({
                success: false,
                message: "Another product already uses this SKU."
            });
        }

        products[index] = {
            ...products[index],
            ...data,
            updated_at: new Date().toISOString()
        };

        saveProducts(products);

        res.json({
            success: true,
            message: "Product updated successfully.",
            product: products[index]
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Could not update product."
        });
    }
});

// ============================================
// DELETE PRODUCT
// ============================================

app.delete("/api/products/:id", function (req, res) {
    try {
        const products = getProducts();
        const id = Number(req.params.id);

        const remaining = products.filter(function (product) {
            return Number(product.id) !== id;
        });

        if (remaining.length === products.length) {
            return res.status(404).json({
                success: false,
                message: "Product not found."
            });
        }

        saveProducts(remaining);

        res.json({
            success: true,
            message: "Product deleted successfully."
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Could not delete product."
        });
    }
});

// ============================================
// SCAN SHELF IMAGE USING OCR
// ============================================

app.post("/api/scans", function (req, res) {
    imageFields(req, res, async function (uploadError) {
        if (uploadError) {
            return res.status(400).json({
                success: false,
                message: uploadError.message || "Image upload failed."
            });
        }

        let imageFile = null;

        try {
            imageFile =
                (req.files.image && req.files.image[0]) ||
                (req.files.shelfImage && req.files.shelfImage[0]);

            if (!imageFile) {
                return res.status(400).json({
                    success: false,
                    message: 'Upload an image using "image" or "shelfImage".'
                });
            }

            // 1. Read actual text from the uploaded photograph.
            const ocrText = await extractImageText(imageFile.path);

            if (!ocrText.trim()) {
                return res.status(422).json({
                    success: false,
                    message:
                        "No readable text found. Take a clearer, closer photograph."
                });
            }

            const products = getProducts();

            // 2. Match the text to a registered product.
            const approvedProduct = matchProduct(
                ocrText,
                products,
                req.body.detected_sku,
                req.body.detected_barcode
            );

            // 3. Extract shelf price and expiry date.
            const shelfPrice = extractShelfPrice(
                ocrText,
                req.body.shelf_price
            );

            const detectedExpiry =
                (req.body.detected_expiry_date &&
                    isValidDate(String(req.body.detected_expiry_date).trim()))
                    ? String(req.body.detected_expiry_date).trim()
                    : extractExpiryDate(ocrText);

            const registeredExpiry = approvedProduct
                ? approvedProduct.expiry_date || null
                : null;

            // 4. Compare price and expiry independently.
            let priceStatus = "UNKNOWN";
            let expiryStatus = "UNKNOWN";
            let status = "UNMATCHED";
            let message = "Product could not be matched to the product file.";

            if (approvedProduct) {
                if (shelfPrice === null) {
                    priceStatus = "UNKNOWN";
                } else if (
                    Number(shelfPrice) ===
                    Number(approvedProduct.approved_price)
                ) {
                    priceStatus = "PASS";
                } else {
                    priceStatus = "PRICE_MISMATCH";
                }

                // The image's detected date takes precedence.
                // If OCR cannot find it, use the registered date and
                // explicitly record that the registered date was used.
                const expiryToCheck = detectedExpiry || registeredExpiry;

                if (expiryToCheck && isValidDate(expiryToCheck)) {
                    expiryStatus = isExpired(expiryToCheck)
                        ? "EXPIRED"
                        : "PASS";
                }

                if (expiryStatus === "EXPIRED") {
                    status = "EXPIRED";
                    message = "The expiry date being checked has passed.";
                } else if (priceStatus === "PRICE_MISMATCH") {
                    status = "PRICE_MISMATCH";
                    message =
                        "Shelf price " + shelfPrice +
                        " does not match approved price " +
                        approvedProduct.approved_price + ".";
                } else if (
                    priceStatus === "UNKNOWN" ||
                    expiryStatus === "UNKNOWN"
                ) {
                    status = "REVIEW";
                    message =
                        "Product matched, but price or expiry needs manual review.";
                } else {
                    status = "PASS";
                    message =
                        "Price matches and the checked expiry date has not passed.";
                }
            }

            // 5. Save the complete scan record.
            const scans = getScans();

            const scan = {
                id: makeId(scans),
                staff_name: String(req.body.staff_name || "Unknown Staff").trim(),
                image: imageFile.filename,

                detected_product: {
                    name: approvedProduct ? approvedProduct.name : null,
                    sku: approvedProduct ? approvedProduct.sku : null,
                    barcode: approvedProduct ? approvedProduct.barcode : null,
                    shelf_price: shelfPrice,
                    expiry_date: detectedExpiry
                },

                approved_price: approvedProduct
                    ? approvedProduct.approved_price
                    : null,

                approved_expiry_date: registeredExpiry,

                expiry_date_source: detectedExpiry
                    ? "OCR_OR_MANUAL_CORRECTION"
                    : (registeredExpiry ? "REGISTERED_PRODUCT" : "NOT_FOUND"),

                currency: approvedProduct
                    ? approvedProduct.currency
                    : "UGX",

                ocr_text: ocrText,
                price_status: priceStatus,
                expiry_status: expiryStatus,
                status,
                message,
                scan_date: new Date().toISOString()
            };

            scans.push(scan);
            saveScans(scans);

            res.status(201).json({
                success: true,
                message: "Image processed. Review OCR results for accuracy.",
                scan
            });
        } catch (error) {
            console.error("OCR scan error:", error);

            res.status(500).json({
                success: false,
                message:
                    "Image processing failed. Check the server terminal.",
                error: error.message
            });
        }
    });
});

// ============================================
// GET SCAN HISTORY
// ============================================

app.get("/api/scans", function (req, res) {
    try {
        const scans = getScans();

        res.json({
            success: true,
            count: scans.length,
            scans
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Could not load scan history."
        });
    }
});

// ============================================
// DASHBOARD STATISTICS
// ============================================

app.get("/api/dashboard", function (req, res) {
    try {
        const products = getProducts();
        const scans = getScans();

        const countStatus = function (status) {
            return scans.filter(function (scan) {
                return scan.status === status;
            }).length;
        };

        const statistics = {
            products: products.length,
            scans: scans.length,
            passed: countStatus("PASS"),
            price_mismatches: countStatus("PRICE_MISMATCH"),
            expired: countStatus("EXPIRED"),
            unmatched: countStatus("UNMATCHED"),
            review: countStatus("REVIEW")
        };

        res.json({
            success: true,
            statistics,

            // Alternative names for dashboard JS compatibility.
            dashboard: {
                totalProducts: statistics.products,
                totalScans: statistics.scans,
                passed: statistics.passed,
                priceMismatches: statistics.price_mismatches,
                expiredProducts: statistics.expired,
                unmatchedProducts: statistics.unmatched,
                review: statistics.review
            }
        });
    } catch (error) {
        console.error(error);

        res.status(500).json({
            success: false,
            message: "Could not load dashboard statistics."
        });
    }
});

// ============================================
// API NOT FOUND
// ============================================

app.use("/api", function (req, res) {
    res.status(404).json({
        success: false,
        message: "API endpoint not found."
    });
});

// ============================================
// GENERAL ERROR HANDLER
// ============================================

app.use(function (error, req, res, next) {
    console.error("Server error:", error.message);

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        success: false,
        message: "An unexpected server error occurred."
    });
});

// ============================================
// START SERVER
// ============================================

app.listen(PORT, function () {
    console.log("========================================");
    console.log(" RETAIL COMPLIANCE SCANNER");
    console.log("========================================");
    console.log("Server:    http://localhost:" + PORT);
    console.log("Health:    http://localhost:" + PORT + "/api/health");
    console.log("Products:  http://localhost:" + PORT + "/api/products");
    console.log("Scans:     http://localhost:" + PORT + "/api/scans");
    console.log("Dashboard: http://localhost:" + PORT + "/api/dashboard");
    console.log("OCR:       Tesseract.js");
    console.log("========================================");
});
