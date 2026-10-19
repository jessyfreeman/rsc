
/* =========================================================
   RETAIL COMPLIANCE SCANNER (RCS)
   Product management, shelf scans, expiry validation,
   dashboard statistics, and correctly ordered tables.
   Storage: browser localStorage
========================================================= */

"use strict";

/* -------------------- STORAGE -------------------- */

const PRODUCT_KEY = "rcs_products";
const SCAN_KEY = "rcs_scans";

function loadStoredData(key) {
    try {
        const data = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(data) ? data : [];
    } catch (error) {
        console.error(`Could not load ${key}:`, error);
        return [];
    }
}

let products = loadStoredData(PRODUCT_KEY);
let scans = loadStoredData(SCAN_KEY);

function saveProducts() {
    localStorage.setItem(PRODUCT_KEY, JSON.stringify(products));
}

function saveScans() {
    localStorage.setItem(SCAN_KEY, JSON.stringify(scans));
}

/* -------------------- GENERAL HELPERS -------------------- */

function getElement(id) {
    return document.getElementById(id);
}

function escapeHTML(value) {
    return String(value ?? "").replace(/[&<>"']/g, character => ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;"
    })[character]);
}

function makeId() {
    return Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8);
}

function money(value, currency = "UGX") {
    const amount = Number(value);

    if (!Number.isFinite(amount)) {
        return `${escapeHTML(currency)} 0`;
    }

    return `${escapeHTML(currency)} ${amount.toLocaleString()}`;
}

function getTodayISO() {
    const today = new Date();

    return [
        today.getFullYear(),
        String(today.getMonth() + 1).padStart(2, "0"),
        String(today.getDate()).padStart(2, "0")
    ].join("-");
}

/* -------------------- EXPIRY DATE FIX -------------------- */

/*
Accepted formats:
    2027-12-31
    31/12/2027
    31-12-2027

All accepted dates are saved as YYYY-MM-DD.
*/

function normalizeExpiryDate(value) {
    if (value === null || value === undefined) {
        return "";
    }

    const input = String(value).trim();

    if (!input) {
        return "";
    }

    let year;
    let month;
    let day;
    let match;

    // Format: YYYY-MM-DD
    match = input.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);

    if (match) {
        year = Number(match[1]);
        month = Number(match[2]);
        day = Number(match[3]);match = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);
    } else {
        // Formats: DD/MM/YYYY or DD-MM-YYYY
        match = input.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/);

        if (!match) {
            return "";
        }

        day = Number(match[1]);
        month = Number(match[2]);
        year = Number(match[3]);
    }

    // Reject impossible dates such as 31/02/2027.
    if (
        year < 1900 ||
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > 31
    ) {
        return "";
    }

    const date = new Date(year, month - 1, day);

    if (
        date.getFullYear() !== year ||
        date.getMonth() !== month - 1 ||
        date.getDate() !== day
    ) {
        return "";
    }

    return [
        year,
        String(month).padStart(2, "0"),
        String(day).padStart(2, "0")
    ].join("-");
}

function isValidISODate(value) {
    return normalizeExpiryDate(value) !== "";
}

function isExpired(value) {
    const normalized = normalizeExpiryDate(value);

    // A blank or unreadable expiry date is not automatically
    // classified as expired.
    if (!normalized) {
        return false;
    }

    return normalized < getTodayISO();
}

function formatDate(value) {
    if (!value) {
        return "Not provided";
    }

    const normalized = normalizeExpiryDate(value);

    if (!normalized) {
        return escapeHTML(value);
    }

    const [year, month, day] = normalized.split("-");

    return `${day}/${month}/${year}`;
}

function formatDateTime(value) {
    if (!value) {
        return "Not recorded";
    }

    const date = new Date(value);

    if (Number.isNaN(date.getTime())) {
        return escapeHTML(value);
    }

    return date.toLocaleString();
}

/* -------------------- PRODUCT NORMALIZATION -------------------- */

function normalizeProduct(product) {
    const expiry = normalizeExpiryDate(
        product.expiry_date ?? product.expiryDate ?? ""
    );

    return {
        ...product,
        id: product.id ?? makeId(),
        name: String(product.name ?? "").trim(),
        sku: String(product.sku ?? "").trim(),
        barcode: String(product.barcode ?? "").trim(),
        approved_price: Number(
            product.approved_price ?? product.approvedPrice ?? 0
        ),
        currency: product.currency || "UGX",
        expiry_date: expiry
    };
}

/* -------------------- SCAN NORMALIZATION -------------------- */

function normalizeScan(scan) {
    const expiry = normalizeExpiryDate(
        scan.expiry_date ?? scan.expiryDate ?? ""
    );

    return {
        ...scan,
        id: scan.id ?? makeId(),
        scanned_at:
            scan.scanned_at ??
            scan.date ??
            scan.created_at ??
            new Date().toISOString(),
        staff_name: String(
            scan.staff_name ?? scan.staff ?? "Store Staff"
        ),
        product_name: String(
            scan.product_name ?? scan.productName ?? scan.name ?? ""
        ),
        sku: String(scan.sku ?? ""),
        shelf_price: Number(
            scan.shelf_price ?? scan.shelfPrice ?? 0
        ),
        currency: scan.currency || "UGX",
        expiry_date: expiry,
        status: String(scan.status ?? "UNMATCHED")
    };
}

/* -------------------- TABLE HELPER -------------------- */

/*
Works when the supplied element is either a table or its tbody.
*/

function getTableBody(id) {
    const element = getElement(id);

    if (!element) {
        return null;
    }

    if (element.tagName.toLowerCase() === "table") {
        return element.querySelector("tbody") || element;
    }

    return element;
}

/* -------------------- ADD PRODUCT -------------------- */

function addProduct(event) {
    if (event) {
        event.preventDefault();
    }

    const skuInput = getElement("sku");
    const barcodeInput = getElement("barcode");
    const nameInput = getElement("name");
    const priceInput = getElement("approved_price");
    const currencyInput = getElement("currency");
    const expiryInput = getElement("expiry_date");

    if (!skuInput || !nameInput || !priceInput) {
        alert("The product form fields could not be found. Check your HTML IDs.");
        return;
    }

    const sku = skuInput.value.trim();
    const barcode = barcodeInput ? barcodeInput.value.trim() : "";
    const name = nameInput.value.trim();
    const price = Number(priceInput.value);
    const currency = currencyInput?.value.trim() || "UGX";
    const rawExpiry = expiryInput?.value.trim() || "";
    const expiry = normalizeExpiryDate(rawExpiry);

    if (!name || !sku || priceInput.value.trim() === "") {
        alert("Please enter the product name, SKU and approved price.");
        return;
    }

    if (!Number.isFinite(price) || price < 0) {
        alert("Please enter a valid approved price.");
        return;
    }

    if (rawExpiry && !expiry) {
        alert(
            "Invalid expiry date. Use YYYY-MM-DD, DD/MM/YYYY or DD-MM-YYYY."
        );
        return;
    }

    const duplicate = products.some(product =>
        product.sku.toLowerCase() === sku.toLowerCase()
    );

    if (duplicate) {
        alert("A product with this SKU already exists.");
        return;
    }

    const product = normalizeProduct({
        id: makeId(),
        sku,
        barcode,
        name,
        approved_price: price,
        currency,
        expiry_date: expiry
    });

    products.push(product);
    saveProducts();

    displayProducts();
    displayDashboardProducts();
    refreshDashboard();

    const productForm = getElement("productForm");

    if (productForm) {
        productForm.reset();
    }

    alert("Product added successfully.");
}

/* -------------------- DISPLAY PRODUCTS -------------------- */

function displayProducts() {
    const table = getTableBody("productTable");

    if (!table) {
        return;
    }

    if (products.length === 0) {
        table.innerHTML = `
            <tr>
                <td colspan="7">No products found.</td>
            </tr>
        `;
        return;
    }

    // Correct Product Master order:
    // ID, Product Name, SKU, Barcode, Approved Price,
    // Expiry Date, Action

    table.innerHTML = products.map((product, index) => `
        <tr>
            <td>${index + 1}</td>
            <td>${escapeHTML(product.name)}</td>
            <td>${escapeHTML(product.sku)}</td>
            <td>${escapeHTML(product.barcode || "—")}</td>
            <td>${money(product.approved_price, product.currency)}</td>
            <td>${formatDate(product.expiry_date)}</td>
            <td>
                <button
                    type="button"
                    class="delete-btn"
                    onclick="deleteProduct('${escapeHTML(product.id)}')">
                    Delete
                </button>
            </td>
        </tr>
    `).join("");
}

function deleteProduct(id) {
    if (!confirm("Are you sure you want to delete this product?")) {
        return;
    }

    products = products.filter(product =>
        String(product.id) !== String(id)
    );

    saveProducts();

    displayProducts();
    displayDashboardProducts();
    refreshDashboard();
}

/* -------------------- SCANNER -------------------- */


async function handleScan() {
    const imageInput = getElement("shelfImage");
    const scanResult = getElement("scanResult");

    if (!imageInput || !imageInput.files || !imageInput.files[0]) {
        alert("Please select or take a shelf photograph.");
        return;
    }

    // Ask for the product SKU first.
    const sku = prompt("Enter the product SKU:");

    if (sku === null || !sku.trim()) {
        alert("Product SKU is required.");
        return;
    }

    // Ask for the product name.
    const productName = prompt("Enter the product name:");

    if (productName === null || !productName.trim()) {
        return;
    }

    // Ask for the shelf price.
    const rawPrice = prompt("Enter the shelf price:");

    if (rawPrice === null || rawPrice.trim() === "") {
        return;
    }

    const shelfPrice = Number(rawPrice);

    if (!Number.isFinite(shelfPrice) || shelfPrice < 0) {
        alert("Please enter a valid shelf price.");
        return;
    }

    // Ask for the expiry date.
    const rawExpiry = prompt(
        "Enter the expiry date (YYYY-MM-DD or DD/MM/YYYY). Leave blank if unreadable:"
    );

    if (rawExpiry === null) {
        return;
    }

    const expiryDate = normalizeExpiryDate(rawExpiry.trim());

    if (rawExpiry.trim() && !expiryDate) {
        alert(
            "Invalid expiry date. Use YYYY-MM-DD, DD/MM/YYYY or DD-MM-YYYY."
        );
        return;
    }

    // Ask for the staff member's name.
    const staffName = prompt("Enter the staff member's name:");

    if (staffName === null || !staffName.trim()) {
        return;
    }

    // Match the entered SKU first.
    const registeredProduct = products.find(product =>
        String(product.sku).trim().toLowerCase() ===
        sku.trim().toLowerCase()
    );

    let status = "UNMATCHED";

    if (registeredProduct) {
        const approvedPrice = Number(registeredProduct.approved_price);

        const productExpired =
            isExpired(registeredProduct.expiry_date) ||
            isExpired(expiryDate);

        if (productExpired) {
            status = "EXPIRED";
        } else if (shelfPrice !== approvedPrice) {
            status = "PRICE MISMATCH";
        } else {
            status = "PASSED";
        }
    }

    const newScan = normalizeScan({
        id: makeId(),
        scanned_at: new Date().toISOString(),
        staff_name: staffName.trim(),
        product_name: productName.trim(),
        sku: sku.trim(),
        shelf_price: shelfPrice,
        currency: registeredProduct?.currency || "UGX",
        expiry_date: expiryDate,
        status
    });

    scans.unshift(newScan);
    saveScans();

    displayDashboardScans();
    refreshDashboard();

    if (scanResult) {
        scanResult.innerHTML = `
            <div class="scan-result ${status.toLowerCase().replace(/\s+/g, "-")}">
                <h3>Scan Result: ${escapeHTML(status)}</h3>
                <p><strong>Product:</strong> ${escapeHTML(newScan.product_name)}</p>
                <p><strong>SKU entered:</strong> ${escapeHTML(newScan.sku)}</p>
                <p><strong>Staff:</strong> ${escapeHTML(newScan.staff_name)}</p>
                <p><strong>Shelf price:</strong> ${money(newScan.shelf_price, newScan.currency)}</p>
                <p><strong>Expiry date:</strong> ${formatDate(newScan.expiry_date)}</p>
                <p><strong>Approved price:</strong> ${
                    registeredProduct
                        ? money(registeredProduct.approved_price, registeredProduct.currency)
                        : "Product not matched"
                }</p>
            </div>
        `;
    }

    alert(`Scan saved. Result: ${status}`);
}


/* -------------------- DISPLAY DASHBOARD PRODUCTS -------------------- */

function displayDashboardProducts() {
    const table = getTableBody("dashboardProducts");

    if (!table) {
        return;
    }

    if (products.length === 0) {
        table.innerHTML = `
            <tr><td colspan="6">No products found.</td></tr>
        `;
        return;
    }

    // Correct dashboard Product Master order:
    // ID, Product Name, SKU, Barcode, Approved Price, Expiry Date

    table.innerHTML = products.map((product, index) => `
        <tr>
            <td>${index + 1}</td>
            <td>${escapeHTML(product.name)}</td>
            <td>${escapeHTML(product.sku)}</td>
            <td>${escapeHTML(product.barcode || "—")}</td>
            <td>${money(product.approved_price, product.currency)}</td>
            <td>${formatDate(product.expiry_date)}</td>
            <td>
                <button
                    type="button"
                    class="delete-btn"
                    onclick="deleteDashboardProduct('${String(product.id).replace(/'/g, "\\'")}')">
                    Delete
                </button>
            </td>
        </tr>
    `).join("");
}

/* -------------------- DISPLAY SCAN HISTORY -------------------- */

function displayDashboardScans() {
    const table =
        getTableBody("dashboardScans") ||
        getTableBody("scanTable");

    if (!table) {
        return;
    }

    if (scans.length === 0) {
        table.innerHTML = `
            <tr><td colspan="8">No scans recorded.</td></tr>
        `;
        return;
    }

    // Correct Scan History order:
    // Date & Time, Staff, Product, SKU, Shelf Price,
    // Expiry, Status, Action

    table.innerHTML = scans.map(scan => `
        <tr>
            <td>${formatDateTime(scan.scanned_at)}</td>
            <td>${escapeHTML(scan.staff_name)}</td>
            <td>${escapeHTML(scan.product_name)}</td>
            <td>${escapeHTML(scan.sku || "—")}</td>
            <td>${money(scan.shelf_price, scan.currency)}</td>
            <td>${formatDate(scan.expiry_date)}</td>
            <td>
                <span class="status ${escapeHTML(
                    scan.status.toLowerCase().replace(/\s+/g, "-")
                )}">
                    ${escapeHTML(scan.status)}
                </span>
            </td>
            <td>
                <button
                    type="button"
                    class="delete-btn"
                    onclick="deleteScan('${escapeHTML(scan.id)}')">
                    Delete
                </button>
            </td>
        </tr>
    `).join("");
}

function deleteScan(id) {
    if (!confirm("Are you sure you want to delete this scan record?")) {
        return;
    }

    scans = scans.filter(scan =>
        String(scan.id) !== String(id)
    );

    saveScans();

    displayDashboardScans();
    refreshDashboard();
}

/* -------------------- DASHBOARD STATISTICS -------------------- */

function setText(id, value) {
    const element = getElement(id);

    if (element) {
        element.textContent = value;
    }
}


function refreshDashboard() {
    // Read the latest saved records.
    products = loadStoredData(PRODUCT_KEY).map(normalizeProduct);
    scans = loadStoredData(SCAN_KEY).map(normalizeScan);

    const totalProducts = products.length;
    const totalScans = scans.length;

    const priceMismatches = scans.filter(
        scan => scan.status === "PRICE MISMATCH"
    ).length;

    const unmatchedProducts = scans.filter(
        scan => scan.status === "UNMATCHED"
    ).length;

    const passedScans = scans.filter(
        scan => scan.status === "PASSED"
    ).length;

    const expiredScans = scans.filter(
        scan => scan.status === "EXPIRED"
    ).length;

    // Compliance rate = passed scans / all scans × 100.
    const complianceRate = totalScans > 0
        ? (passedScans / totalScans) * 100
        : 0;

    setText("totalProducts", totalProducts);
    setText("totalScans", totalScans);
    setText("priceMismatches", priceMismatches);
    setText("unmatchedProducts", unmatchedProducts);
    setText("passed", passedScans);

    // Support either of these IDs for the expired counter.
    setText(
        "expiredProducts",
        products.filter(product => isExpired(product.expiry_date)).length
            + expiredScans
    );

    // Support either compliance-rate ID.
    setText("complianceRate", `${complianceRate.toFixed(1)}%`);
    setText("compliance-rate", `${complianceRate.toFixed(1)}%`);
}

/* -------------------- LOAD AND START -------------------- */

function loadRCSData() {
    // Normalize saved data so older records use the same structure.
    products = loadStoredData(PRODUCT_KEY).map(normalizeProduct);
    scans = loadStoredData(SCAN_KEY).map(normalizeScan);

    saveProducts();
    saveScans();

    displayProducts();
    displayDashboardProducts();
    displayDashboardScans();
    refreshDashboard();
}

document.addEventListener("DOMContentLoaded", () => {
    loadRCSData();

    const productForm = getElement("productForm");

    if (productForm) {
        productForm.addEventListener("submit", addProduct);
    }

    const scanButton = getElement("scanButton");

    if (scanButton) {
        scanButton.addEventListener("click", handleScan);
    }
});

function deleteDashboardProduct(productId) {
    const product = products.find(
        item => String(item.id) === String(productId)
    );

    if (!product) {
        alert("Product not found.");
        return;
    }

    const confirmed = confirm(
        `Are you sure you want to delete "${product.name}"?`
    );

    if (!confirmed) return;

    products = products.filter(
        item => String(item.id) !== String(productId)
    );

    // Save the updated product list to localStorage.
    localStorage.setItem(PRODUCT_KEY, JSON.stringify(products));

    // Refresh the dashboard and product displays.
    displayDashboardProducts();
    displayProducts();
    refreshDashboard();

    alert("Product deleted successfully.");
}
