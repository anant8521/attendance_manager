// export-xlsx.js
//
// Produces real, cell-styled .xlsx files (colors, borders, merged title,
// bold headers, conditional attendance-% colors) using xlsx-js-style, a
// community fork of SheetJS that adds cell styling to the free/open build.
// Loaded via <script> in index.html; if that CDN load fails (e.g. the very
// first app open with no internet at all), `xlsxReady()` returns false and
// every caller below shows a toast asking the person to check their
// connection and retry (see notifyNoXlsx) instead of exporting a file.
//
// Known limitations (being upfront rather than overclaiming — browser-side
// xlsx generation has real ceilings here):
//   - Freeze panes and print page-setup (landscape/fit-to-page/repeat header)
//     are written best-effort; some Excel/LibreOffice versions honor them,
//     others ignore JS-set view/pageSetup properties entirely. If it doesn't
//     stick, set it once in Excel (View → Freeze Panes, Page Layout) and it
//     will persist for that file from then on.
//   - Per-page footers with live page numbers are a print-time Excel feature
//     that isn't controllable from a JS-generated workbook — a static
//     "Exported <date> <time>" footer ROW is added under the table instead.
//   - Attendance-% "conditional formatting" is computed once at export time
//     (colored based on the value at that moment) rather than a live Excel
//     formula rule that recalculates if someone edits the sheet afterwards.

const INSTITUTION_LINE1 = "Government Polytechnic Munger";
const INSTITUTION_LINE2 = "Department of Electrical Engineering";

function xlsxReady(){ return typeof XLSX !== "undefined" && !!XLSX.utils; }

function notifyNoXlsx(){
  toast("Excel library hasn't loaded yet — this needs an internet connection the first time. Please check your connection and try again.","info");
}

const FONT_FAMILY = "Calibri";
const HEADER_FILL = "1F3864";      // dark blue
const PRESENT_FILL = "1FA971"; const PRESENT_FONT = "FFFFFF";
const ABSENT_FILL  = "FDEAEA"; const ABSENT_FONT  = "C0392B";
const PCT_GREEN = "1FA971", PCT_YELLOW = "E0932F", PCT_RED = "E5484D";

// Palette used ONLY by the "My Attendance Report" / "Attendance Log -
// Subject-wise" sheets (student's own export) — kept separate from the
// constants above so the admin/teacher register, session-report and
// history exports elsewhere in this file are completely untouched.
const MY_NAVY        = "17365D"; // Primary Navy
const MY_SECTION_NAVY= "1F4E78"; // Section Navy
const MY_TABLE_BLUE   = "4472C4"; // Table Blue
const MY_GREEN        = "21A366"; // Present Green
const MY_GREEN_LIGHT  = "E2F0D9"; // Light Present
const MY_RED          = "D9534F"; // Absent Red
const MY_RED_LIGHT    = "FCE4D6"; // Light Absent
const MY_AMBER        = "F4B183"; // Attention Amber
const MY_GRAY_LIGHT   = "F2F2F2"; // Light Gray
const MY_BORDER       = "D9E1F2"; // Border
const myThinBorder = { style:"thin", color:{ rgb:MY_BORDER } };
const MY_BORDER_ALL = { top:myThinBorder, bottom:myThinBorder, left:myThinBorder, right:myThinBorder };
// Attendance-% colour tiers for the My Attendance sheets specifically
// (matches the reference design: 100% is the only "pure green" number,
// everything from 65%–99.99% reads as amber/"Good", below 65% is red) —
// deliberately separate from the shared pctCellStyle()/statusColor()
// used by the admin/teacher exports below, which keep their own rule.
function myPctTextColor(pct){ return pct>=100 ? MY_GREEN : pct>=65 ? "C97A1F" : MY_RED; }
function myStatusLabel(pct){ return pct>=100 ? "Excellent" : pct>=75 ? "Good" : pct>=65 ? "Attention" : "Shortage"; }
function myStatusPillColor(pct){ return pct>=75 ? MY_GREEN : pct>=65 ? MY_AMBER : MY_RED; }
function myPctCellStyle(pct){
  return { font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb: myPctTextColor(pct) } },
    alignment:{ horizontal:"center", vertical:"center" }, border:MY_BORDER_ALL, numFmt:'0.00"%"' };
}
function myStatusCellStyle(pct){
  const bg = myStatusPillColor(pct);
  // Amber/red pills need a dark readable label; the green pill (like the
  // reference) reads fine in white.
  const fontColor = bg===MY_AMBER ? "7A4A00" : "FFFFFF";
  return { font:{ name:FONT_FAMILY, sz:10.5, bold:true, color:{ rgb: fontColor } },
    fill:{ fgColor:{ rgb: bg } }, alignment:{ horizontal:"center", vertical:"center" }, border:MY_BORDER_ALL };
}
function myLogPresentCellStyle(){
  return { font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb:"1B7943" } }, fill:{ fgColor:{ rgb:MY_GREEN_LIGHT } },
    alignment:{ horizontal:"center", vertical:"center" }, border:MY_BORDER_ALL };
}
function myLogAbsentCellStyle(){
  return { font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb:"B23A2E" } }, fill:{ fgColor:{ rgb:MY_RED_LIGHT } },
    alignment:{ horizontal:"center", vertical:"center" }, border:MY_BORDER_ALL };
}

const thinBorder = { style:"thin", color:{ rgb:"BFBFBF" } };
const BORDER_ALL = { top:thinBorder, bottom:thinBorder, left:thinBorder, right:thinBorder };

function cell(v, style){ return { v, s: style, t: typeof v === "number" ? "n" : "s" }; }
// Rough wrapped-line estimate for a cell's text at a given column width (in
// Excel's "characters" unit) — used to AutoFit row heights. Deliberately
// simple (no per-character kerning math, Excel doesn't expose that to JS)
// but good enough to keep long wrapped cells from being clipped.
function estimateWrappedLines(text, wch){
  const str = String(text ?? "");
  if(!str) return 1;
  const charsPerLine = Math.max(1, Math.floor(wch) - 1);
  return Math.max(1, Math.ceil(str.length / charsPerLine));
}
function titleStyle(size){ return { font:{ name:FONT_FAMILY, bold:true, sz:size||14 }, alignment:{ horizontal:"center", vertical:"center" } }; }
function headerStyle(){
  return { font:{ name:FONT_FAMILY, bold:true, sz:12, color:{ rgb:"FFFFFF" } },
    fill:{ fgColor:{ rgb:HEADER_FILL } },
    alignment:{ horizontal:"center", vertical:"center", wrapText:true },
    border: BORDER_ALL };
}
function bodyStyle(extra){
  return Object.assign({ font:{ name:FONT_FAMILY, sz:11 },
    // wrapText is deliberately OFF by default — most columns here (S.No,
    // Roll No, dates, P/A marks, percentages) are short fixed-format
    // values that should stay on one compact line. Only genuinely long
    // free-text columns opt into wrapping via nameStyle() below.
    alignment:{ horizontal:"center", vertical:"center", wrapText:false },
    border: BORDER_ALL }, extra||{});
}
function nameStyle(){ return bodyStyle({ alignment:{ horizontal:"left", vertical:"center", wrapText:true } }); }
function presentCellStyle(){ return bodyStyle({ font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb:PRESENT_FONT } }, fill:{ fgColor:{ rgb:PRESENT_FILL } } }); }
function absentCellStyle(){ return bodyStyle({ font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb:ABSENT_FONT } }, fill:{ fgColor:{ rgb:ABSENT_FILL } } }); }
function pctCellStyle(pct){
  const color = pct>=75 ? PCT_GREEN : pct>=60 ? PCT_YELLOW : PCT_RED;
  return bodyStyle({ font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb:"FFFFFF" } }, fill:{ fgColor:{ rgb:color } }, numFmt:'0.00"%"' });
}

/* Generic builder: title (2 lines) + subtitle line + header row + data rows +
   footer row, with column widths, freeze header, and best-effort print setup. */
// subjectLine: single merged title line (e.g. "T2420501 – Switchgear and Protection").
// infoLines: optional extra merged lines between the subject line and the
//   table (e.g. "Date: ... | Time: ... | Faculty: ..." style summary rows) —
//   used by the Attendance Report export; other exports simply omit it.
// afterLines: optional extra merged lines between the table and the footer
//   (e.g. "Present Roll Numbers: ...") — same idea, after the data.
function buildRegisterSheet({ subjectLine, infoLines, headers, rows, colWidths, afterLines, footerNote }){
  infoLines = infoLines || [];
  afterLines = afterLines || [];
  const aoa = [];
  const colCount = headers.length;
  const mergedRowIdx = [];
  const pushMerged = text => { aoa.push([text, ...Array(colCount-1).fill("")]); mergedRowIdx.push(aoa.length-1); };

  pushMerged(INSTITUTION_LINE1);
  pushMerged(INSTITUTION_LINE2);
  pushMerged(subjectLine);
  infoLines.forEach(pushMerged);
  aoa.push(Array(colCount).fill(""));           // blank spacer row
  const headerRowIdx = aoa.length; aoa.push(headers);
  rows.forEach(r => aoa.push(r));
  afterLines.forEach(pushMerged);
  pushMerged(footerNote);
  const footerRowIdx = aoa.length - 1;

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = mergedRowIdx.map(r => ({ s:{r,c:0}, e:{r,c:colCount-1} }));

  for(let c=0;c<colCount;c++){
    setCellStyle(ws, 0, c, titleStyle(15));
    setCellStyle(ws, 1, c, titleStyle(12));
    setCellStyle(ws, 2, c, titleStyle(12));
    setCellStyle(ws, headerRowIdx, c, headerStyle());
    setCellStyle(ws, footerRowIdx, c, { font:{ name:FONT_FAMILY, sz:9, italic:true, color:{ rgb:"888888" } }, alignment:{ horizontal:"left" } });
  }
  // Info/after lines (if any) get a plain bold left-aligned line style —
  // distinct from the big centered institution/subject titles.
  mergedRowIdx.forEach(r => {
    if(r > 2 && r !== footerRowIdx){
      for(let c=0;c<colCount;c++) setCellStyle(ws, r, c, { font:{ name:FONT_FAMILY, sz:11, bold:true }, alignment:{ horizontal:"left", vertical:"center" } });
    }
  });
  // AutoFit columns: size each column to its longest cell (header or data),
  // using the caller's colWidths as a sensible minimum (so e.g. a "P/A"
  // column never shrinks to a sliver) rather than a hard fixed width. Capped
  // at 55 chars so one unusually long entry can't blow out the whole sheet —
  // beyond that, the cell wraps onto extra lines instead (see row heights).
  ws["!cols"] = headers.map((h, c) => {
    let max = String(h).length;
    rows.forEach(r => {
      const raw = r[c];
      const v = (raw && typeof raw === "object") ? (raw.v ?? "") : (raw ?? "");
      max = Math.max(max, String(v).length);
    });
    const minWch = (colWidths && colWidths[c]) || 10;
    return { wch: Math.min(Math.max(max + 2, minWch), 55) };
  });
  // AutoFit row heights: each row is sized to however many wrapped lines its
  // tallest cell actually needs (only cells with wrapText enabled — see
  // bodyStyle/nameStyle — are considered), instead of one fixed height for
  // every row. Keeps short rows compact and only grows the rows that
  // genuinely contain long wrapped text (long subject names, long absent
  // roll-number lists, etc.), so nothing gets visually clipped and nothing
  // wastes vertical space.
  const mergedRowSet = new Set([...mergedRowIdx]);
  const totalWch = ws["!cols"].reduce((sum, col) => sum + col.wch, 0);
  const LINE_PX = 16; // ~single line height at 11pt Calibri
  ws["!rows"] = aoa.map((row, r) => {
    let maxLines = 1;
    if(mergedRowSet.has(r)){
      // Title/info/after/footer rows are merged across every column, so
      // they wrap against the full combined width, not a single column's.
      maxLines = estimateWrappedLines(row[0], totalWch);
    }else{
      row.forEach((c, ci) => {
        const wraps = c && c.s && c.s.alignment && c.s.alignment.wrapText;
        if(!wraps) return;
        const wch = (ws["!cols"][ci] && ws["!cols"][ci].wch) || 12;
        maxLines = Math.max(maxLines, estimateWrappedLines(c.v, wch));
      });
    }
    return { hpx: Math.max(20, 6 + LINE_PX * maxLines) };
  });
  // Best-effort freeze of the header row so it stays visible while scrolling.
  const freezeSplit = headerRowIdx + 1;
  ws["!freeze"] = { xSplit:0, ySplit:freezeSplit };
  ws["!sheetViews"] = [{ state:"frozen", ySplit:freezeSplit, topLeftCell:`A${freezeSplit+1}`, activePane:"bottomLeft" }];
  ws["!margins"] = { left:0.3, right:0.3, top:0.4, bottom:0.4, header:0.3, footer:0.3 };
  ws["!pageSetup"] = { orientation:"landscape", fitToWidth:1, fitToHeight:0 };
  return ws;
}
function setCellStyle(ws, r, c, style){
  const addr = XLSX.utils.encode_cell({ r, c });
  if(!ws[addr]) ws[addr] = { t:"s", v:"" };
  ws[addr].s = style;
}

function exportTimestampFooter(){
  const now = new Date();
  return `Exported: ${now.toLocaleDateString()} ${now.toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}`;
}
function safeSheetName(name){ return name.replace(/[\\/*?:\[\]]/g,"").slice(0,31); }
function triggerXlsxDownload(wb, filename){
  XLSX.writeFile(wb, filename);
}

/* ---------- 1. Subject Register export ---------- */
// rows: [{ sNo, rollNo, name, cells:["present"|"absent"|null, ...], present, absent, pctNum }]
// dateLabels: ["01 Jul", "02 Jul", ...] — same order/length as each row's `cells`
function exportRegisterXlsx({ subject, dateLabels, rows }){
  if(!xlsxReady()){ notifyNoXlsx(); return false; }
  const headers = ["S.No","Student Name","Roll No", ...dateLabels, "Total Attend Class","Total Conduct Class","Attendance %"];
  const colWidths = [8,30,15, ...dateLabels.map(()=>12), 20,20,15];
  const dataRows = rows.map(r=>{
    const row = [ cell(r.sNo, bodyStyle()), cell(r.name, nameStyle()), cell(r.rollNo, bodyStyle()) ];
    r.cells.forEach(status=>{
      if(status === "present") row.push(cell("P", presentCellStyle()));
      else if(status === "absent") row.push(cell("A", absentCellStyle()));
      else row.push(cell("–", bodyStyle()));
    });
    row.push(cell(r.present, bodyStyle({ font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb:"1FA971" } } })));
    row.push(cell(r.absent, bodyStyle({ font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb:"E5484D" } } })));
    row.push(cell(r.pctNum, pctCellStyle(r.pctNum)));
    return row;
  });
  const ws = buildRegisterSheet({
    subjectLine: `${subject.code} – ${subject.name}  (Faculty: ${subject.faculty})`,
    headers, rows: dataRows, colWidths, footerNote: exportTimestampFooter()+`  |  Sheet: ${subject.code}_Register`
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName(`${subject.code}_Register`));
  triggerXlsxDownload(wb, `${subject.code}_Register.xlsx`);
  return true;
}

/* ---------- 2. Attendance Report (single session) export ----------
   Complete professional report — NOT the Simple/Detailed Share Preview
   text. Institution/Department header (from buildRegisterSheet), a
   Date/Time/Faculty + summary-counts info block, then one combined
   Present+Absent student table (S.No, Name, Roll No, Reg No if any
   student has one, Status), then the roll-number summary lines. */
function exportReportXlsx({ subject, date, time, faculty, total, present, absent, pct, presentRolls, absentRolls, presentList, absentList }){
  if(!xlsxReady()){ notifyNoXlsx(); return false; }
  presentList = presentList || []; absentList = absentList || [];
  const anyRegNo = [...presentList, ...absentList].some(s => s && s.regNo);
  const headers = anyRegNo
    ? ["S.No","Student Name","Roll No","Reg No","Status"]
    : ["S.No","Student Name","Roll No","Status"];
  const colWidths = anyRegNo ? [8,28,14,16,12] : [8,30,16,12];
  let sNo = 0;
  const studentRow = (s, status) => {
    sNo++;
    const row = [ cell(sNo, bodyStyle()), cell(s.name, nameStyle()), cell(s.rollNo, bodyStyle()) ];
    if(anyRegNo) row.push(cell(s.regNo || "—", bodyStyle()));
    row.push(cell(status, status==="Present" ? presentCellStyle() : absentCellStyle()));
    return row;
  };
  const dataRows = [
    ...presentList.map(s => studentRow(s, "Present")),
    ...absentList.map(s => studentRow(s, "Absent"))
  ];
  if(!dataRows.length){
    dataRows.push([cell("No students recorded", nameStyle()), cell("", bodyStyle()), cell("", bodyStyle()), ...(anyRegNo?[cell("", bodyStyle())]:[]), cell("", bodyStyle())]);
  }
  const infoLines = [
    `Date: ${date}   |   Time: ${time}   |   Faculty: ${faculty || "—"}`,
    `Total Students: ${total}   |   Total Present: ${present}   |   Total Absent: ${absent}   |   Attendance %: ${pct}%`
  ];
  const afterLines = [
    `Present Roll Numbers: ${presentRolls || "—"}`,
    `Absent Roll Numbers: ${absentRolls || "—"}`
  ];
  const ws = buildRegisterSheet({
    subjectLine: `${subject.code}${subject.code&&subject.name?" – ":""}${subject.name}`,
    infoLines, headers, rows: dataRows, colWidths, afterLines,
    footerNote: exportTimestampFooter()+"  |  Sheet: Attendance_Report"
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName("Attendance_Report"));
  triggerXlsxDownload(wb, `attendance_report_${date}.xlsx`);
  return true;
}

/* ---------- 3. Student List export ---------- */
function exportStudentListXlsx(students){
  if(!xlsxReady()){ notifyNoXlsx(); return false; }
  const headers = ["S.No","Student Name","Roll No","Registration No"];
  const dataRows = students.map(s=>[
    cell(s.sNo, bodyStyle()), cell(s.name, nameStyle()), cell(s.rollNo, bodyStyle()), cell(s.regNo||"—", bodyStyle())
  ]);
  const ws = buildRegisterSheet({
    subjectLine: "Student List",
    headers, rows: dataRows, colWidths: [8,15,30,20], footerNote: exportTimestampFooter()+"  |  Sheet: Student_List"
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName("Student_List"));
  triggerXlsxDownload(wb, "student_list.xlsx");
  return true;
}

/* ---------- 4. History export ---------- */
// Column order matches the requested report format exactly: Date, Subject,
// Total Students, Present, Absent, Attendance %, Present Roll Numbers,
// Absent Roll Numbers. Present and Absent roll numbers are both derived from
// the SAME per-student marks map (sessionPresentStudents/sessionAbsentStudents,
// defined in app.js) — never from "everyone else" — so the two lists can
// never be swapped or mixed, and each is sorted ascending by roll number.
function exportHistoryXlsx(sessions){
  if(!xlsxReady()){ notifyNoXlsx(); return false; }
  const headers = ["Date","Time","Subject Code","Subject","Faculty","Total Students","Present","Absent","Attendance %","Present Roll Numbers","Absent Roll Numbers"];
  const dataRows = sessions.map(r=>{
    const presentStudents = sessionPresentStudents(r);
    const absentStudents = sessionAbsentStudents(r);
    return [
      cell(r.date, bodyStyle()), cell(r.time||"—", bodyStyle()), cell(r.subjectCode||"", bodyStyle()),
      cell(r.subject, nameStyle()), cell(r.faculty, bodyStyle()), cell(r.total, bodyStyle()),
      cell(r.present, presentCellStyle()),
      cell(r.absent != null ? r.absent : (r.total - r.present), absentCellStyle()),
      cell(parseFloat(r.pct), pctCellStyle(parseFloat(r.pct))),
      cell(presentStudents.map(s=>s.rollNo).join(", "), nameStyle()),
      cell(absentStudents.map(s=>s.rollNo).join(", "), nameStyle())
    ];
  });
  const ws = buildRegisterSheet({
    subjectLine: "Attendance History — All Sessions",
    headers, rows: dataRows, colWidths: [12,10,14,26,16,13,10,10,13,30,30], footerNote: exportTimestampFooter()+"  |  Sheet: Attendance_History"
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, safeSheetName("Attendance_History"));
  triggerXlsxDownload(wb, "attendance_history.xlsx");
  return true;
}

/* ---------- 5. My Attendance (single student, all subjects) export ----------
   Two-sheet workbook per the student "My Attendance" redesign:
     Sheet 1 "My Attendance Report"       — overview + subject-wise table
     Sheet 2 "Attendance Log - Subject-wise" — full date-wise log, grouped
                                                by subject, plus a subject
                                                totals table at the bottom
   `data` comes from buildMyAttendanceExportData() in app.js:
   { studentName, rollNo, generated,
     overall:{conducted,present,absent,pct},
     subjects:[{code,name,faculty,present,conducted,absent,pct,status}],
     log:[{code,name,faculty,present,conducted,absent,pct,sessions:[{date,status}]}] }
   Nothing here is hardcoded — every value is read from `data`, which is
   itself built fresh from DB.sessions at export time. */
const DAY_NAMES = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
function isoToDDMMMYYYY(iso){
  const [y,m,d] = iso.split("-");
  return `${d}-${MONTH_SHORT_XLSX[parseInt(m,10)-1]}-${y}`;
}
const MONTH_SHORT_XLSX = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
function isoToDayName(iso){
  return DAY_NAMES[new Date(iso+"T00:00:00").getDay()];
}
function sectionHeaderStyle(){
  return { font:{ name:FONT_FAMILY, bold:true, sz:12, color:{ rgb:"FFFFFF" } }, fill:{ fgColor:{ rgb:HEADER_FILL } },
    alignment:{ horizontal:"left", vertical:"center" } };
}
function overviewLabelStyle(){ return { font:{ name:FONT_FAMILY, bold:true, sz:10.5, color:{ rgb:"FFFFFF" } }, fill:{ fgColor:{ rgb:"2E4C82" } }, alignment:{ horizontal:"center", vertical:"center" }, border:BORDER_ALL }; }
function overviewValueStyle(color){ return { font:{ name:FONT_FAMILY, bold:true, sz:15, color:{ rgb: color || "1A1A2E" } }, alignment:{ horizontal:"center", vertical:"center" }, border:BORDER_ALL }; }
function sectionHeaderStyle(){
  return { font:{ name:FONT_FAMILY, bold:true, sz:12, color:{ rgb:"FFFFFF" } }, fill:{ fgColor:{ rgb:MY_NAVY } },
    alignment:{ horizontal:"center", vertical:"center" } };
}
function overviewLabelStyle(){ return { font:{ name:FONT_FAMILY, bold:true, sz:10.5, color:{ rgb:MY_NAVY } }, fill:{ fgColor:{ rgb:MY_GRAY_LIGHT } }, alignment:{ horizontal:"center", vertical:"center" }, border:MY_BORDER_ALL }; }
function overviewValueStyle(color){ return { font:{ name:FONT_FAMILY, bold:true, sz:17, color:{ rgb: color || MY_NAVY } }, alignment:{ horizontal:"center", vertical:"center" }, border:MY_BORDER_ALL }; }
// Overall-attendance summary color: a coarser traffic-light rule (green
// once healthy at ≥75%, amber 65–74.99%, red below) — distinct from the
// stricter per-subject tiering in myPctTextColor(), same as the on-screen
// hero card which is also green well below 100%.
function myOverallColor(pct){ return pct>=75 ? MY_GREEN : pct>=65 ? "C97A1F" : MY_RED; }

function exportMyAttendanceXlsx(data){
  if(!xlsxReady()){ notifyNoXlsx(); return false; }
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, buildMyAttendanceReportSheet(data), safeSheetName("My Attendance Report"));
  XLSX.utils.book_append_sheet(wb, buildMyAttendanceLogSheet(data), safeSheetName("Attendance Log - Subject-wise"));
  triggerXlsxDownload(wb, `my_attendance_${data.rollNo || "report"}.xlsx`.replace(/\s+/g,"_"));
  return true;
}

/* ---- Sheet 1: My Attendance Report ---- */
function buildMyAttendanceReportSheet(data){
  const COLS = 8; // matches the subject-wise table's column count
  const headers = ["Subject Code","Subject","Faculty","Present","Conducted","Absent","Attendance %","Status"];
  const colWidths = [10,15,12,8,9,7,10,8];
  const aoa = [];
  const merge = [];
  const pushMerged = (text, span) => {
    span = span || COLS;
    const row = [text, ...Array(COLS-1).fill("")];
    aoa.push(row);
    merge.push({ s:{ r: aoa.length-1, c:0 }, e:{ r: aoa.length-1, c: span-1 } });
    return aoa.length-1;
  };
  // Pushes one row with a left label/value pair (columns 0-3) and an
  // optional right label/value pair (columns 4-7) — the two-column
  // student-info layout from the reference design.
  const infoRows = [];
  const pushInfoRow = (labelL, valueL, labelR, valueR) => {
    const row = Array(COLS).fill("");
    row[0] = labelL ? `${labelL} :` : ""; row[2] = valueL || "";
    row[4] = labelR ? `${labelR} :` : ""; row[6] = valueR || "";
    aoa.push(row);
    const r = aoa.length-1;
    merge.push({ s:{r,c:0}, e:{r,c:1} }, { s:{r,c:2}, e:{r,c:3} });
    if(labelR){ merge.push({ s:{r,c:4}, e:{r,c:5} }, { s:{r,c:6}, e:{r,c:7} }); }
    infoRows.push(r);
    return r;
  };

  // Header hierarchy: Institution → Department → Report title, all
  // centered, largest-to-smallest — no "Institution:"/"Department:"
  // labels, the names appear directly as specified.
  const rInst = pushMerged(INSTITUTION_LINE1);
  const rDept = pushMerged(INSTITUTION_LINE2);
  const rTitle = pushMerged("MY ATTENDANCE REPORT");
  aoa.push(Array(COLS).fill(""));
  // Student info: clean two-column layout — Student Name / Roll Number /
  // Semester on the left, Academic Session / Generated on the right.
  pushInfoRow("Student Name", data.studentName, "Academic Session", data.academicSession);
  pushInfoRow("Roll Number", data.rollNo, "Generated", data.generated);
  if(data.semester) pushInfoRow("Semester", data.semester, "", "");
  aoa.push(Array(COLS).fill(""));
  const rOverviewTitle = pushMerged("ATTENDANCE OVERVIEW");
  // Overview "cards": 4 metrics, each spanning 2 of the 8 columns — a label
  // row followed by a big value row, so it reads like the on-screen hero
  // card's stat strip.
  const rOvLabels = aoa.length;
  aoa.push(["CLASSES CONDUCTED","","PRESENT","","ABSENT","","OVERALL ATTENDANCE",""]);
  const rOvValues = aoa.length;
  aoa.push([data.overall.conducted, "", data.overall.present, "", data.overall.absent, "", data.overall.conducted ? `${data.overall.pct.toFixed(2)}%` : "—", ""]);
  [[0,1],[2,3],[4,5],[6,7]].forEach(([a,b])=>{
    merge.push({ s:{r:rOvLabels,c:a}, e:{r:rOvLabels,c:b} });
    merge.push({ s:{r:rOvValues,c:a}, e:{r:rOvValues,c:b} });
  });
  aoa.push(Array(COLS).fill(""));
  const rSubTitle = pushMerged("SUBJECT-WISE ATTENDANCE");
  const rHeader = aoa.length; aoa.push(headers);
  const subjectRowIdxs = [];
  data.subjects.forEach(s=>{
    subjectRowIdxs.push(aoa.length);
    aoa.push([s.code, s.name, s.faculty, s.present, s.conducted, s.absent, s.pct, myStatusLabel(s.pct)]);
  });
  if(!data.subjects.length) aoa.push(["No attendance recorded yet.", "", "", "", "", "", "", ""]);
  aoa.push(Array(COLS).fill(""));
  const rFooter = pushMerged(exportTimestampFooter()+"  |  Sheet: My Attendance Report");

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merge;
  for(let c=0;c<COLS;c++){
    // Institution → Department → Report title: centered, dark navy,
    // large-to-small (per the report header hierarchy spec).
    setCellStyle(ws, rInst, c, { font:{ name:FONT_FAMILY, bold:true, sz:17, color:{ rgb:MY_NAVY } }, alignment:{ horizontal:"center", vertical:"center" } });
    setCellStyle(ws, rDept, c, { font:{ name:FONT_FAMILY, bold:true, sz:14, color:{ rgb:MY_NAVY } }, alignment:{ horizontal:"center", vertical:"center" } });
    setCellStyle(ws, rTitle, c, { font:{ name:FONT_FAMILY, bold:true, sz:12, color:{ rgb:"555555" } }, alignment:{ horizontal:"center", vertical:"center" } });
    setCellStyle(ws, rOverviewTitle, c, sectionHeaderStyle());
    setCellStyle(ws, rOvLabels, c, overviewLabelStyle());
    setCellStyle(ws, rSubTitle, c, sectionHeaderStyle());
    setCellStyle(ws, rHeader, c, headerStyle());
    setCellStyle(ws, rFooter, c, { font:{ name:FONT_FAMILY, sz:9, italic:true, color:{ rgb:"888888" } }, alignment:{ horizontal:"left" } });
  }
  // Student info block — bold labels, clean readable values, two columns.
  // wrapText on the labels guards against clipping (e.g. "Academic
  // Session :") if their merged width is ever tight for a given font.
  infoRows.forEach(r=>{
    [0,4].forEach(c=> setCellStyle(ws, r, c, { font:{ name:FONT_FAMILY, bold:true, sz:10.5, color:{ rgb:"333333" } }, alignment:{ horizontal:"left", vertical:"center", wrapText:true } }));
    [2,6].forEach(c=> setCellStyle(ws, r, c, { font:{ name:FONT_FAMILY, sz:10.5, color:{ rgb:"1A1A2E" } }, alignment:{ horizontal:"left", vertical:"center", wrapText:true } }));
  });
  const ovValueColors = [MY_NAVY, MY_GREEN, MY_RED, data.overall.conducted ? myOverallColor(data.overall.pct) : "888888"];
  [0,2,4,6].forEach((c,i)=> setCellStyle(ws, rOvValues, c, overviewValueStyle(ovValueColors[i])));
  subjectRowIdxs.forEach(r=>{
    setCellStyle(ws, r, 0, bodyStyle({ border:MY_BORDER_ALL }));
    setCellStyle(ws, r, 1, nameStyle());
    ws[XLSX.utils.encode_cell({r,c:1})].s.border = MY_BORDER_ALL;
    setCellStyle(ws, r, 2, nameStyle());
    ws[XLSX.utils.encode_cell({r,c:2})].s.border = MY_BORDER_ALL;
    setCellStyle(ws, r, 3, bodyStyle({ font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb:MY_GREEN } }, border:MY_BORDER_ALL }));
    setCellStyle(ws, r, 4, bodyStyle({ border:MY_BORDER_ALL }));
    setCellStyle(ws, r, 5, bodyStyle({ font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb:MY_RED } }, border:MY_BORDER_ALL }));
    const pctVal = ws[XLSX.utils.encode_cell({r,c:6})].v;
    setCellStyle(ws, r, 6, myPctCellStyle(pctVal));
    const statusVal = ws[XLSX.utils.encode_cell({r,c:7})].v;
    setCellStyle(ws, r, 7, myStatusCellStyle(pctVal));
  });

  // NOTE: the vendored (offline, free) xlsx writer does not serialize
  // !pageSetup / !margins / scale into the actual file — Excel/LibreOffice
  // fall back to their own default print settings regardless of what we
  // set below. The reliable lever we DO have is keeping the columns
  // themselves narrow (colCaps) and letting wrapText + generous row
  // heights absorb long text vertically instead of stretching columns
  // wide, so the table stays inside one landscape page's width at 100%
  // zoom without depending on scale-to-fit being honored.
  const colCaps = [12,17,14,9,10,8,11,9];
  ws["!cols"] = colWidths.map((w,c)=>{
    let max = String(headers[c]).length;
    subjectRowIdxs.forEach(r=>{ max = Math.max(max, String(aoa[r][c] ?? "").length); });
    return { wch: Math.min(Math.max(max+2, w), colCaps[c]) };
  });
  ws["!rows"] = aoa.map((row, r)=>{
    if(r===rInst) return { hpx:28 };
    if(r===rDept) return { hpx:22 };
    if(r===rTitle) return { hpx:20 };
    if(infoRows.includes(r)) return { hpx:26 };
    if(subjectRowIdxs.includes(r)){
      // Estimate wrapped line count generously (word-wrap breaks at word
      // boundaries, not mid-word, so it usually needs a line or two more
      // than a pure character-count division) — better a slightly taller
      // row than clipped text.
      const linesFor = (text, wch) => Math.ceil(String(text||"").length / Math.max(6, wch-2)) ;
      const nameLines = linesFor(row[1], ws["!cols"][1].wch);
      const facLines = linesFor(row[2], ws["!cols"][2].wch);
      const lines = Math.max(1, nameLines, facLines) + 1; // +1 buffer line
      return { hpx: Math.max(20, 17 * lines) };
    }
    return { hpx: 20 };
  });
  ws["!freeze"] = { xSplit:0, ySplit: rHeader+1 };
  ws["!sheetViews"] = [{ state:"frozen", ySplit: rHeader+1, topLeftCell:`A${rHeader+2}`, activePane:"bottomLeft" }];
  if(subjectRowIdxs.length){
    ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s:{r:rHeader,c:0}, e:{r:subjectRowIdxs[subjectRowIdxs.length-1],c:COLS-1} }) };
  }
  ws["!margins"] = { left:0.25, right:0.25, top:0.4, bottom:0.4, header:0.3, footer:0.3 };
  ws["!pageSetup"] = { orientation:"landscape", paperSize:9, fitToWidth:1, fitToHeight:0, scale:62 };
  return ws;
}
/* ---- Sheet 2: Attendance Log - Subject-wise ---- */
function buildMyAttendanceLogSheet(data){
  const COLS = 3; // Date | Day | Status — matches the reference exactly
  const aoa = [];
  const merge = [];
  const pushMerged = (text) => {
    aoa.push([text, ...Array(COLS-1).fill("")]);
    merge.push({ s:{ r: aoa.length-1, c:0 }, e:{ r: aoa.length-1, c: COLS-1 } });
    return aoa.length-1;
  };
  const styledRows = { title:[], faculty:[], footer:[] };
  const subjectHeadRows = []; // { row, codeLen } — code pill + name, same row
  const totalRows = []; // { row, pct }

  const rTitle = pushMerged("ATTENDANCE LOG — SUBJECT-WISE"); styledRows.title.push(rTitle);
  const rStudent = pushMerged(`Student: ${data.studentName} (${data.rollNo})`); styledRows.faculty.push(rStudent);
  aoa.push(Array(COLS).fill(""));

  const dateHeaderRows = [];
  data.log.forEach(sub=>{
    // Subject code (as a filled pill in column A) + subject name (bold,
    // spanning the rest of the row) — one row, matching the reference.
    aoa.push([sub.code, sub.name, ""]);
    const rHead = aoa.length-1;
    merge.push({ s:{r:rHead,c:1}, e:{r:rHead,c:COLS-1} });
    subjectHeadRows.push(rHead);
    const rFaculty = pushMerged(`Faculty: ${sub.faculty}`); styledRows.faculty.push(rFaculty);
    const rHeader = aoa.length; aoa.push(["Date","Day","Status"]); dateHeaderRows.push(rHeader);
    const sessionRows = [];
    sub.sessions.forEach(s=>{
      sessionRows.push(aoa.length);
      aoa.push([isoToDDMMMYYYY(s.date), isoToDayName(s.date), s.status]);
    });
    if(!sub.sessions.length){ aoa.push(["No sessions recorded", "", ""]); }
    // A single clean summary row (light blue-gray bar) — split across the
    // 3 real columns so the Attendance% figure can still be tier-colored:
    // col A = "SUBJECT TOTAL", col B = Conducted/Present/Absent counts,
    // col C = the coloured Attendance % figure.
    aoa.push(["SUBJECT TOTAL", `Conducted: ${sub.conducted}   |   Present: ${sub.present}   |   Absent: ${sub.absent}`, `Attendance: ${sub.pct.toFixed(2)}%`]);
    totalRows.push({ row: aoa.length-1, pct: sub.pct });
    aoa.push(Array(COLS).fill(""));
    sub._headerRow = rHeader; sub._sessionRows = sessionRows;
  });

  const rFooter = pushMerged(exportTimestampFooter()+"  |  Sheet: Attendance Log - Subject-wise"); styledRows.footer.push(rFooter);

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws["!merges"] = merge;
  for(let c=0;c<COLS;c++){
    setCellStyle(ws, rTitle, c, { font:{ name:FONT_FAMILY, bold:true, sz:15, color:{ rgb:MY_NAVY } }, alignment:{ horizontal:"center", vertical:"center" } });
    setCellStyle(ws, rStudent, c, { font:{ name:FONT_FAMILY, sz:11, bold:true, color:{ rgb:"333333" } }, alignment:{ horizontal:"left" } });
    styledRows.faculty.slice(1).forEach(r=> setCellStyle(ws, r, c, { font:{ name:FONT_FAMILY, sz:10.5, italic:true, color:{ rgb:"5B6780" } }, alignment:{ horizontal:"left" } }));
    styledRows.footer.forEach(r=> setCellStyle(ws, r, c, { font:{ name:FONT_FAMILY, sz:9, italic:true, color:{ rgb:"888888" } }, alignment:{ horizontal:"left" } }));
  }
  // Subject code pill (col A) + subject name (bold navy, spanning B:C).
  subjectHeadRows.forEach(r=>{
    setCellStyle(ws, r, 0, { font:{ name:FONT_FAMILY, bold:true, sz:11, color:{ rgb:"FFFFFF" } }, fill:{ fgColor:{ rgb:MY_NAVY } }, alignment:{ horizontal:"center", vertical:"center" } });
    setCellStyle(ws, r, 1, { font:{ name:FONT_FAMILY, bold:true, sz:12.5, color:{ rgb:MY_NAVY } }, alignment:{ horizontal:"left", vertical:"center" } });
  });
  dateHeaderRows.forEach(r=>{
    for(let c=0;c<3;c++) setCellStyle(ws, r, c, headerStyle());
  });
  data.log.forEach(sub=>{
    sub._sessionRows.forEach(r=>{
      setCellStyle(ws, r, 0, bodyStyle({ border:MY_BORDER_ALL }));
      setCellStyle(ws, r, 1, bodyStyle({ border:MY_BORDER_ALL }));
      const statusVal = ws[XLSX.utils.encode_cell({r,c:2})].v;
      setCellStyle(ws, r, 2, statusVal==="Present" ? myLogPresentCellStyle() : myLogAbsentCellStyle());
    });
  });
  // Subject Total row: light blue-gray bar, tier-colored Attendance % cell.
  totalRows.forEach(({row, pct})=>{
    setCellStyle(ws, row, 0, { font:{ name:FONT_FAMILY, sz:10.5, bold:true, color:{ rgb:MY_NAVY } }, fill:{ fgColor:{ rgb:"E9EEF7" } }, alignment:{ horizontal:"left", vertical:"center" } });
    setCellStyle(ws, row, 1, { font:{ name:FONT_FAMILY, sz:10.5, bold:true, color:{ rgb:"333333" } }, fill:{ fgColor:{ rgb:"E9EEF7" } }, alignment:{ horizontal:"left", vertical:"center" } });
    setCellStyle(ws, row, 2, { font:{ name:FONT_FAMILY, sz:10.5, bold:true, color:{ rgb: myPctTextColor(pct) } }, fill:{ fgColor:{ rgb:"E9EEF7" } }, alignment:{ horizontal:"left", vertical:"center" } });
  });

  ws["!cols"] = [ { wch:24 }, { wch:40 }, { wch:24 } ];
  ws["!rows"] = aoa.map((row, r)=> r===rTitle ? { hpx:24 } : { hpx:19 });
  if(dateHeaderRows.length){
    ws["!freeze"] = { xSplit:0, ySplit: dateHeaderRows[0]+1 };
  }
  ws["!margins"] = { left:0.25, right:0.25, top:0.4, bottom:0.4, header:0.3, footer:0.3 };
  ws["!pageSetup"] = { orientation:"landscape", paperSize:9, fitToWidth:1, fitToHeight:0, scale:85 };
  return ws;
}

