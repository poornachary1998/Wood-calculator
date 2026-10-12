(function () {
  "use strict";

  const ERROR_MESSAGES = {
    no_image: "No photo was received. Please choose a photo first.",
    unsupported_format:
      "That file type isn't supported. Please upload a JPEG, PNG, WEBP, or HEIC photo.",
    too_large: "That photo is too large. Please upload a photo under 10MB.",
    invalid_json:
      "Couldn't read this photo clearly. Try a clearer, closer, or better-lit photo.",
    no_rows_found:
      "No measurement rows were found in this photo. Try a clearer, closer, or better-lit photo.",
    rate_limited: "The service is busy right now. Please try again in a moment.",
    upstream_error: "Something went wrong talking to the extraction service.",
  };

  /** @type {{sections: Array<{name: string, rows: Array<{qty: number, valuesText: string}>}>}} */
  const state = { sections: [] };

  let selectedFile = null;

  const dropZone = document.getElementById("drop-zone");
  const fileInput = document.getElementById("file-input");
  const preview = document.getElementById("preview");
  const extractBtn = document.getElementById("extract-btn");
  const statusMessage = document.getElementById("status-message");
  const sectionsContainer = document.getElementById("sections-container");
  const addSectionBtn = document.getElementById("add-section-btn");
  const grandTotalEl = document.getElementById("grand-total");
  const downloadDocBtn = document.getElementById("download-doc-btn");

  // --- Upload handling -----------------------------------------------

  dropZone.addEventListener("click", () => fileInput.click());

  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.classList.add("dragover");
  });

  dropZone.addEventListener("dragleave", () => {
    dropZone.classList.remove("dragover");
  });

  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    dropZone.classList.remove("dragover");
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      setSelectedFile(e.dataTransfer.files[0]);
    }
  });

  fileInput.addEventListener("change", () => {
    if (fileInput.files && fileInput.files[0]) {
      setSelectedFile(fileInput.files[0]);
    }
  });

  function setSelectedFile(file) {
    selectedFile = file;
    extractBtn.disabled = false;
    clearStatus();

    const reader = new FileReader();
    reader.onload = () => {
      preview.src = reader.result;
      preview.style.display = "block";
    };
    reader.readAsDataURL(file);
  }

  function clearStatus() {
    statusMessage.textContent = "";
    statusMessage.className = "";
  }

  function showError(message) {
    statusMessage.textContent = message;
    statusMessage.className = "error";
  }

  function showInfo(message) {
    statusMessage.textContent = message;
    statusMessage.className = "info";
  }

  extractBtn.addEventListener("click", async () => {
    if (!selectedFile) return;

    extractBtn.disabled = true;
    showInfo("Reading photo…");

    const formData = new FormData();
    formData.append("image", selectedFile);

    try {
      const res = await fetch("/api/extract", {
        method: "POST",
        body: formData,
      });
      const data = await res.json();

      if (!res.ok) {
        const code = data && data.error && data.error.code;
        showError(ERROR_MESSAGES[code] || "Something went wrong. Please try again.");
        return;
      }

      applyExtraction(data);
      clearStatus();
    } catch (err) {
      showError("Couldn't reach the server. Please check your connection and try again.");
    } finally {
      extractBtn.disabled = false;
    }
  });

  function applyExtraction(data) {
    const sections = (data.sections || []).map((section) => ({
      name: section.name || "Section",
      rows: (section.rows || []).map((row) => ({
        qty: typeof row.qty === "number" ? row.qty : 0,
        valuesText: (row.values || []).join(" x "),
      })),
    }));
    state.sections = state.sections.concat(sections);
    render();
  }

  // --- Manual editing ---------------------------------------------------

  addSectionBtn.addEventListener("click", () => {
    state.sections.push({ name: `Section ${state.sections.length + 1}`, rows: [] });
    render();
  });

  function addRow(sectionIndex) {
    state.sections[sectionIndex].rows.push({ qty: 1, valuesText: "" });
    render();
  }

  function removeRow(sectionIndex, rowIndex) {
    state.sections[sectionIndex].rows.splice(rowIndex, 1);
    render();
  }

  function removeSection(sectionIndex) {
    state.sections.splice(sectionIndex, 1);
    render();
  }

  // --- Calculation engine ------------------------------------------------

  function parseNumbers(text) {
    const matches = String(text || "").match(/-?\d+(\.\d+)?/g);
    if (!matches) return [];
    return matches.map(Number);
  }

  function rowTotal(row) {
    const numbers = parseNumbers(row.valuesText);
    if (numbers.length === 0) return 0;
    const product = numbers.reduce((acc, n) => acc * n, 1);
    return round3((Number(row.qty) || 0) * product / 144);
  }

  function sectionTotal(section) {
    return round3(section.rows.reduce((sum, row) => sum + rowTotal(row), 0));
  }

  function grandTotal() {
    return round3(state.sections.reduce((sum, section) => sum + sectionTotal(section), 0));
  }

  // Rounds to 3 decimal places so every row, section and grand total adds up
  // exactly to the values shown on screen (e.g. 7.809).
  function round3(n) {
    return Math.round((n + Number.EPSILON) * 1000) / 1000;
  }

  function fmt(n) {
    return n.toFixed(3);
  }

  // --- Rendering -----------------------------------------------------------

  function render() {
    sectionsContainer.innerHTML = "";

    state.sections.forEach((section, sectionIndex) => {
      const block = document.createElement("div");
      block.className = "section-block";

      const header = document.createElement("div");
      header.className = "section-header";

      const nameInput = document.createElement("input");
      nameInput.type = "text";
      nameInput.value = section.name;
      nameInput.addEventListener("input", () => {
        section.name = nameInput.value;
      });
      header.appendChild(nameInput);

      const totalSpan = document.createElement("span");
      totalSpan.className = "section-total";
      totalSpan.textContent = `${fmt(sectionTotal(section))} sq ft`;
      header.appendChild(totalSpan);

      const sectionActions = document.createElement("div");
      sectionActions.className = "section-actions";

      const removeSectionBtn = document.createElement("button");
      removeSectionBtn.className = "small";
      removeSectionBtn.textContent = "Remove section";
      removeSectionBtn.addEventListener("click", () => removeSection(sectionIndex));
      sectionActions.appendChild(removeSectionBtn);

      header.appendChild(sectionActions);
      block.appendChild(header);

      const table = document.createElement("table");
      table.innerHTML = `
        <thead>
          <tr>
            <th style="width: 15%">Qty</th>
            <th>Dimensions</th>
            <th style="width: 15%">Total (sq ft)</th>
            <th style="width: 10%"></th>
          </tr>
        </thead>
      `;

      const tbody = document.createElement("tbody");

      section.rows.forEach((row, rowIndex) => {
        const tr = document.createElement("tr");

        const qtyTd = document.createElement("td");
        const qtyInput = document.createElement("input");
        qtyInput.type = "number";
        qtyInput.step = "any";
        qtyInput.value = row.qty;
        qtyInput.addEventListener("input", () => {
          row.qty = qtyInput.value === "" ? 0 : Number(qtyInput.value);
          updateTotals();
        });
        qtyTd.appendChild(qtyInput);
        tr.appendChild(qtyTd);

        const valuesTd = document.createElement("td");
        const valuesInput = document.createElement("input");
        valuesInput.type = "text";
        valuesInput.placeholder = "e.g. 4.25 x 1.5 x 96";
        valuesInput.value = row.valuesText;
        valuesInput.addEventListener("input", () => {
          row.valuesText = valuesInput.value;
          updateTotals();
        });
        valuesTd.appendChild(valuesInput);
        tr.appendChild(valuesTd);

        const totalTd = document.createElement("td");
        totalTd.className = "row-total-cell";
        totalTd.textContent = fmt(rowTotal(row));
        tr.appendChild(totalTd);

        const actionsTd = document.createElement("td");
        const removeRowBtn = document.createElement("button");
        removeRowBtn.className = "small";
        removeRowBtn.textContent = "×";
        removeRowBtn.addEventListener("click", () => removeRow(sectionIndex, rowIndex));
        actionsTd.appendChild(removeRowBtn);
        tr.appendChild(actionsTd);

        tbody.appendChild(tr);
      });

      table.appendChild(tbody);
      block.appendChild(table);

      const addRowBtn = document.createElement("button");
      addRowBtn.className = "small";
      addRowBtn.style.marginTop = "0.5rem";
      addRowBtn.textContent = "+ Add row";
      addRowBtn.addEventListener("click", () => addRow(sectionIndex));
      block.appendChild(addRowBtn);

      sectionsContainer.appendChild(block);
    });

    updateTotals();
  }

  function updateTotals() {
    document.querySelectorAll(".section-block").forEach((block, sectionIndex) => {
      const section = state.sections[sectionIndex];
      block.querySelector(".section-total").textContent = `${fmt(sectionTotal(section))} sq ft`;

      const rowCells = block.querySelectorAll("tbody tr .row-total-cell");
      section.rows.forEach((row, rowIndex) => {
        if (rowCells[rowIndex]) {
          rowCells[rowIndex].textContent = fmt(rowTotal(row));
        }
      });
    });

    grandTotalEl.textContent = fmt(grandTotal());
  }

  // --- Word export ---------------------------------------------------------

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);
  }

  // Business details printed on the shop's bill book, shown in Telugu and
  // English at the top of every exported document.
  const BUSINESS = {
    nameTe: "శ్రీ విరాట్ వుడెన్ ఫర్నీచర్, బిల్డింగ్ వర్క్స్ & అల్యూమినియం వర్క్స్",
    nameEn: "Sri Virat Wooden Furniture, Building Works & Aluminium Works",
    taglineTe: "వృత్తి నైపుణ్యత గల వారిచే చేయబడును",
    taglineEn: "Work done by skilled professionals",
    addressTe: "మంచిర్యాల చౌరస్తా, మసీదు ఎదురుగా, కరీంనగర్ - 505 001.",
    addressEn: "Mancherial Chowrasta, Opp. Masjid, Karimnagar - 505 001.",
    proprietorTe: "ప్రొ॥ యన్. శ్రీనివాస్",
    proprietorEn: "Prop. N. Srinivas",
    phone: "9849523572",
  };

  const GREEN = "#1a7f3c";
  const RED = "#c8321e";

  // Word opens HTML saved with a .doc extension and the msword MIME type, so
  // the cut-list can be exported without a document-generation library.
  function buildDocHtml() {
    const border = `border:1px solid ${GREEN};`;
    const th = `${border}padding:5px 6px;color:${GREEN};font-weight:bold;text-align:center;`;
    const td = `${border}padding:5px 6px;`;
    const today = new Date().toLocaleDateString("en-IN");

    let serial = 0;
    const sectionsHtml = state.sections.map((section) => {
      const rowsHtml = section.rows.map((row) => `
          <tr>
            <td style="${td}text-align:center">${++serial}</td>
            <td style="${td}">${escapeHtml(row.valuesText)}</td>
            <td style="${td}text-align:center">${escapeHtml(row.qty)}</td>
            <td style="${td}text-align:right">${fmt(rowTotal(row))}</td>
          </tr>`).join("");
      return `
          <tr>
            <td style="${td}background:#eef7f0;color:${GREEN};font-weight:bold" colspan="4">
              ${escapeHtml(section.name)}
            </td>
          </tr>
          ${rowsHtml}
          <tr>
            <td style="${td}text-align:right" colspan="3"><b>Section total</b></td>
            <td style="${td}text-align:right"><b>${fmt(sectionTotal(section))}</b></td>
          </tr>`;
    }).join("");

    return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
      <head>
        <meta charset="utf-8">
        <title>${escapeHtml(BUSINESS.nameEn)} - Cut-List</title>
        <style>
          @page { size: A4; margin: 1.5cm; }
          body { font-family: "Nirmala UI", Gautami, "Noto Sans Telugu", Calibri, Arial, sans-serif; font-size: 11pt; }
          p { margin: 2px 0; }
        </style>
      </head>
      <body>
        <table style="border-collapse:collapse;width:100%;border:2px solid ${GREEN}">
          <tr><td style="padding:10px 12px">
            <p style="text-align:right;color:${GREEN};font-weight:bold">సెల్ / Cell: ${BUSINESS.phone}</p>
            <p style="text-align:center;color:${RED};font-size:17pt;font-weight:bold">${BUSINESS.nameTe}</p>
            <p style="text-align:center;color:${RED};font-size:13pt;font-weight:bold">${BUSINESS.nameEn}</p>
            <p style="text-align:center;color:${GREEN};font-weight:bold">${BUSINESS.taglineTe} &nbsp;|&nbsp; ${BUSINESS.taglineEn}</p>
            <p style="text-align:center;color:${GREEN}">${BUSINESS.addressTe}</p>
            <p style="text-align:center;color:${GREEN}">${BUSINESS.addressEn}</p>
            <p style="text-align:center;color:${RED};font-weight:bold">${BUSINESS.proprietorTe} &nbsp;|&nbsp; ${BUSINESS.proprietorEn}</p>
          </td></tr>
        </table>

        <table style="width:100%;margin-top:10px;color:${GREEN};font-weight:bold">
          <tr>
            <td>నెం. / No.: ____________</td>
            <td style="text-align:right">తేది / Date: <span style="color:#000">${escapeHtml(today)}</span></td>
          </tr>
          <tr>
            <td colspan="2" style="padding-top:8px">శ్రీ / To: ______________________________________________</td>
          </tr>
        </table>

        <table style="border-collapse:collapse;width:100%;margin-top:10px">
          <tr>
            <th style="${th}width:10%">క్ర.సం.<br>Sl. No.</th>
            <th style="${th}">వివరాలు<br>Particulars</th>
            <th style="${th}width:12%">సంఖ్య<br>Qty.</th>
            <th style="${th}width:20%">మొత్తం<br>Total (sq ft)</th>
          </tr>
          ${sectionsHtml}
          <tr>
            <td style="${td}text-align:right;color:${GREEN};font-size:12pt" colspan="3">
              <b>మొత్తం / Grand Total</b>
            </td>
            <td style="${td}text-align:right;font-size:12pt"><b>${fmt(grandTotal())}</b></td>
          </tr>
        </table>

        <p style="text-align:right;color:${RED};margin-top:50px">______________________</p>
        <p style="text-align:right;color:${RED};font-style:italic">సంతకం / Signature</p>
      </body></html>`;
  }

  downloadDocBtn.addEventListener("click", () => {
    if (state.sections.length === 0) {
      showError("Nothing to download yet. Add a section or extract a photo first.");
      return;
    }
    clearStatus();
    const blob = new Blob(["\ufeff", buildDocHtml()], { type: "application/msword" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `wood-cut-list-${new Date().toISOString().slice(0, 10)}.doc`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  });

  render();
})();
