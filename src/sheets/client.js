const { google } = require("googleapis");

function columnLetter(index) {
  let n = index + 1;
  let result = "";
  while (n > 0) {
    const remainder = (n - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    n = Math.floor((n - 1) / 26);
  }
  return result;
}

function parseServiceAccount(json) {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch (error) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON");
  }
}

class SheetsClient {
  constructor({ spreadsheetId, serviceAccountJson, sheetsApi }) {
    this.spreadsheetId = spreadsheetId;
    this.sheetsApi = sheetsApi;
    this.serviceAccountJson = serviceAccountJson;
  }

  static async create(config) {
    if (config.sheetsApi) return new SheetsClient(config);

    const credentials = parseServiceAccount(config.serviceAccountJson);
    const auth = new google.auth.GoogleAuth({
      credentials: credentials || undefined,
      scopes: ["https://www.googleapis.com/auth/spreadsheets"]
    });

    const sheetsApi = google.sheets({ version: "v4", auth });
    return new SheetsClient({ ...config, sheetsApi });
  }

  async getMetadata() {
    const response = await this.sheetsApi.spreadsheets.get({
      spreadsheetId: this.spreadsheetId,
      fields: "spreadsheetId,properties.title,sheets.properties"
    });
    return response.data;
  }

  async ensureSheets(sheetNames) {
    const metadata = await this.getMetadata();
    const existing = new Set(metadata.sheets.map((sheet) => sheet.properties.title));
    const requests = sheetNames
      .filter((title) => !existing.has(title))
      .map((title) => ({ addSheet: { properties: { title, gridProperties: { rowCount: 1000, columnCount: 60 } } } }));

    if (requests.length > 0) {
      await this.batchUpdate(requests);
    }
  }

  async batchUpdate(requests) {
    if (!requests.length) return null;
    const response = await this.sheetsApi.spreadsheets.batchUpdate({
      spreadsheetId: this.spreadsheetId,
      requestBody: { requests }
    });
    return response.data;
  }

  async getValues(sheetName, range = "A:ZZ") {
    const response = await this.sheetsApi.spreadsheets.values.get({
      spreadsheetId: this.spreadsheetId,
      range: `'${sheetName.replace(/'/g, "''")}'!${range}`,
      valueRenderOption: "UNFORMATTED_VALUE"
    });
    return response.data.values || [];
  }

  async updateValues(sheetName, startCell, values) {
    const response = await this.sheetsApi.spreadsheets.values.update({
      spreadsheetId: this.spreadsheetId,
      range: `'${sheetName.replace(/'/g, "''")}'!${startCell}`,
      valueInputOption: "USER_ENTERED",
      requestBody: { values }
    });
    return response.data;
  }

  async appendValues(sheetName, values) {
    const response = await this.sheetsApi.spreadsheets.values.append({
      spreadsheetId: this.spreadsheetId,
      range: `'${sheetName.replace(/'/g, "''")}'!A:ZZ`,
      valueInputOption: "USER_ENTERED",
      insertDataOption: "INSERT_ROWS",
      requestBody: { values }
    });
    return response.data;
  }

  async readTable(sheetName) {
    const values = await this.getValues(sheetName);
    const headers = (values[0] || []).map((header) => String(header || "").trim());
    const rows = values.slice(1).map((valuesRow, index) => {
      const row = { _rowNumber: index + 2 };
      headers.forEach((header, columnIndex) => {
        if (header) row[header] = valuesRow[columnIndex] === undefined ? "" : valuesRow[columnIndex];
      });
      return row;
    });
    return { headers, rows };
  }

  async writeHeader(sheetName, headers) {
    return this.updateValues(sheetName, "A1", [headers]);
  }

  async writeRows(sheetName, headers, rows) {
    const values = rows.map((row) => headers.map((header) => row[header] || ""));
    if (values.length === 0) return null;
    const endColumn = columnLetter(headers.length - 1);
    return this.updateValues(sheetName, `A2:${endColumn}${rows.length + 1}`, values);
  }

  async appendRow(sheetName, headers, row) {
    return this.appendValues(sheetName, [headers.map((header) => row[header] || "")]);
  }

  async updateRow(sheetName, headers, rowNumber, row) {
    const endColumn = columnLetter(headers.length - 1);
    return this.updateValues(sheetName, `A${rowNumber}:${endColumn}${rowNumber}`, [headers.map((header) => row[header] || "")]);
  }
}

module.exports = { SheetsClient, columnLetter };
