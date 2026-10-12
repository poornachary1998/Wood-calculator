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
    quota_exceeded:
      "The AI service's usage limit has been reached. Wait a minute and try again; if it keeps happening, today's quota is used up.",
    invalid_api_key: "The AI service rejected the API key. Check the API key in the server settings.",
    model_not_found: "The AI model configured on the server is no longer available.",
    provider_timeout: "The AI service took too long to respond. Please try again.",
    server_misconfigured: "The server is missing its AI API key. Add it in the server settings.",
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
        const serverMessage = data && data.error && data.error.message;
        showError(ERROR_MESSAGES[code] || serverMessage || "Something went wrong. Please try again.");
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

  const GREEN = "1A7F3C";
  const RED = "C8321E";
  const LIGHT_GREEN = "EEF7F0";
  // Nirmala UI ships with Windows and Office and covers both Telugu and Latin.
  const FONT = { ascii: "Nirmala UI", hAnsi: "Nirmala UI", cs: "Nirmala UI", eastAsia: "Nirmala UI" };

  // Builds a real .docx (Office Open XML) with the docx library loaded from
  // vendor/, so it opens in Word on desktop and phone, Google Docs and WPS.
  function buildDocx() {
    const {
      Document, Paragraph, TextRun, Table, TableRow, TableCell, WidthType,
      AlignmentType, BorderStyle, ShadingType, VerticalAlign,
    } = window.docx;

    // sizePt is in points; docx expects half-points. Complex-script variants
    // are set too so Telugu text gets the same size and weight as English.
    function run(text, { color = "000000", sizePt = 11, bold = false, italics = false } = {}) {
      return new TextRun({
        text: String(text),
        font: FONT,
        color,
        size: sizePt * 2,
        sizeComplexScript: sizePt * 2,
        bold,
        boldComplexScript: bold,
        italics,
        italicsComplexScript: italics,
      });
    }

    function para(runs, { align = AlignmentType.LEFT, after = 40, before = 0 } = {}) {
      return new Paragraph({ children: runs, alignment: align, spacing: { before, after } });
    }

    const greenLine = { style: BorderStyle.SINGLE, size: 6, color: GREEN };
    const cellBorders = { top: greenLine, bottom: greenLine, left: greenLine, right: greenLine };

    function cell(children, { widthPct, span, shade, align = AlignmentType.LEFT } = {}) {
      return new TableCell({
        children: [para(children, { align, after: 0 })],
        columnSpan: span,
        width: widthPct ? { size: widthPct, type: WidthType.PERCENTAGE } : undefined,
        shading: shade ? { type: ShadingType.CLEAR, color: "auto", fill: shade } : undefined,
        borders: cellBorders,
        verticalAlign: VerticalAlign.CENTER,
        margins: { top: 60, bottom: 60, left: 100, right: 100 },
      });
    }

    const center = AlignmentType.CENTER;
    const right = AlignmentType.RIGHT;
    const noBorder = { style: BorderStyle.NONE, size: 0, color: "FFFFFF" };
    const noBorders = {
      top: noBorder, bottom: noBorder, left: noBorder, right: noBorder,
      insideHorizontal: noBorder, insideVertical: noBorder,
    };
    const fullWidth = { size: 100, type: WidthType.PERCENTAGE };

    // Branded header box, mirroring the printed bill book.
    const thickGreen = { style: BorderStyle.DOUBLE, size: 6, color: GREEN };
    const header = new Table({
      width: fullWidth,
      rows: [new TableRow({
        children: [new TableCell({
          borders: { top: thickGreen, bottom: thickGreen, left: thickGreen, right: thickGreen },
          margins: { top: 120, bottom: 120, left: 160, right: 160 },
          children: [
            para([run(`సెల్ / Cell: ${BUSINESS.phone}`, { color: GREEN, bold: true })], { align: right }),
            para([run(BUSINESS.nameTe, { color: RED, sizePt: 16, bold: true })], { align: center }),
            para([run(BUSINESS.nameEn, { color: RED, sizePt: 13, bold: true })], { align: center, after: 80 }),
            para([run(`${BUSINESS.taglineTe}  |  ${BUSINESS.taglineEn}`, { color: GREEN, bold: true })], { align: center }),
            para([run(BUSINESS.addressTe, { color: GREEN })], { align: center }),
            para([run(BUSINESS.addressEn, { color: GREEN })], { align: center }),
            para([run(`${BUSINESS.proprietorTe}  |  ${BUSINESS.proprietorEn}`, { color: RED, bold: true })], { align: center }),
          ],
        })],
      })],
    });

    const label = (text) => run(text, { color: GREEN, bold: true });
    const today = new Date().toLocaleDateString("en-IN");
    const billFields = new Table({
      width: fullWidth,
      borders: noBorders,
      rows: [
        new TableRow({
          children: [
            new TableCell({ borders: noBorders, children: [para([label("నెం. / No.: "), run("____________")])] }),
            new TableCell({ borders: noBorders, children: [para([label("తేది / Date: "), run(today)], { align: right })] }),
          ],
        }),
        new TableRow({
          children: [new TableCell({
            borders: noBorders,
            columnSpan: 2,
            children: [para([label("శ్రీ / To: "), run("_______________________________________________")], { before: 80 })],
          })],
        }),
      ],
    });

    const heading = (te, en, widthPct) => cell(
      [run(te, { color: GREEN, bold: true }), new TextRun({ break: 1 }), run(en, { color: GREEN, bold: true })],
      { widthPct, align: center },
    );

    const itemRows = [new TableRow({
      tableHeader: true,
      children: [
        heading("క్ర.సం.", "Sl. No.", 10),
        heading("వివరాలు", "Particulars", 52),
        heading("సంఖ్య", "Qty.", 13),
        heading("మొత్తం", "Total (sq ft)", 25),
      ],
    })];

    let serial = 0;
    state.sections.forEach((section) => {
      itemRows.push(new TableRow({
        children: [cell([run(section.name, { color: GREEN, bold: true })], { span: 4, shade: LIGHT_GREEN })],
      }));
      section.rows.forEach((row) => {
        serial += 1;
        itemRows.push(new TableRow({
          children: [
            cell([run(serial)], { align: center }),
            cell([run(row.valuesText)]),
            cell([run(row.qty)], { align: center }),
            cell([run(fmt(rowTotal(row)))], { align: right }),
          ],
        }));
      });
      itemRows.push(new TableRow({
        children: [
          cell([run("Section total", { bold: true })], { span: 3, align: right }),
          cell([run(fmt(sectionTotal(section)), { bold: true })], { align: right }),
        ],
      }));
    });

    itemRows.push(new TableRow({
      children: [
        cell([run("మొత్తం / Grand Total", { color: GREEN, sizePt: 12, bold: true })], { span: 3, align: right }),
        cell([run(fmt(grandTotal()), { sizePt: 12, bold: true })], { align: right }),
      ],
    }));

    const items = new Table({ width: fullWidth, rows: itemRows });

    return new Document({
      creator: BUSINESS.nameEn,
      title: `${BUSINESS.nameEn} - Cut-List`,
      styles: { default: { document: { run: { font: FONT, size: 22 } } } },
      sections: [{
        properties: {
          page: {
            size: { width: 11906, height: 16838 }, // A4
            margin: { top: 850, bottom: 850, left: 850, right: 850 },
          },
        },
        children: [
          header,
          para([], { after: 120 }),
          billFields,
          para([], { after: 120 }),
          items,
          para([run("______________________", { color: RED })], { align: right, before: 900, after: 0 }),
          para([run("సంతకం / Signature", { color: RED, italics: true })], { align: right }),
        ],
      }],
    });
  }

  downloadDocBtn.addEventListener("click", async () => {
    if (state.sections.length === 0) {
      showError("Nothing to download yet. Add a section or extract a photo first.");
      return;
    }
    if (!window.docx) {
      showError("The Word export couldn't load. Please refresh the page and try again.");
      return;
    }
    clearStatus();
    try {
      const blob = await window.docx.Packer.toBlob(buildDocx());
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = `wood-cut-list-${new Date().toISOString().slice(0, 10)}.docx`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (err) {
      console.error(err);
      showError("Couldn't create the Word document. Please try again.");
    }
  });

  render();
})();
