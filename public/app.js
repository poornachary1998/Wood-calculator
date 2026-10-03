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

  // Word opens HTML saved with a .doc extension and the msword MIME type, so
  // the cut-list can be exported without a document-generation library.
  function buildDocHtml() {
    const cell = "border:1px solid #999;padding:4px 8px;";
    const sectionsHtml = state.sections.map((section) => {
      const rowsHtml = section.rows.map((row) => `
        <tr>
          <td style="${cell}">${escapeHtml(row.qty)}</td>
          <td style="${cell}">${escapeHtml(row.valuesText)}</td>
          <td style="${cell}text-align:right">${fmt(rowTotal(row))}</td>
        </tr>`).join("");
      return `
        <h2>${escapeHtml(section.name)}</h2>
        <table style="border-collapse:collapse;width:100%">
          <tr>
            <th style="${cell}text-align:left">Qty</th>
            <th style="${cell}text-align:left">Dimensions</th>
            <th style="${cell}text-align:right">Total (sq ft)</th>
          </tr>
          ${rowsHtml}
          <tr>
            <td style="${cell}" colspan="2"><b>Section total</b></td>
            <td style="${cell}text-align:right"><b>${fmt(sectionTotal(section))}</b></td>
          </tr>
        </table>`;
    }).join("");

    return `<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:w="urn:schemas-microsoft-com:office:word"
      xmlns="http://www.w3.org/TR/REC-html40">
      <head><meta charset="utf-8"><title>Wood Cut-List</title></head>
      <body style="font-family:Calibri,Arial,sans-serif">
        <h1>Wood Cut-List</h1>
        <p>Generated ${escapeHtml(new Date().toLocaleString())}</p>
        ${sectionsHtml}
        <h2>Grand total: ${fmt(grandTotal())} sq ft</h2>
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
