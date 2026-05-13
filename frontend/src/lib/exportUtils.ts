/**
 * Export utilities for CSV and PDF formats
 */

export interface SensorReading {
  id: number;
  powerWatts?: string | null;
  energyKwh?: string | null;
  voltageAC?: string | null;
  currentAC?: string | null;
  powerFactor?: string | null;
  temperatureCelsius?: string | null;
  humidityPercent?: number | null;
  pressureHpa?: string | null;
  windSpeedMs?: string | null;
  readingTime: Date | string;
  createdAt: Date | string;
}

/**
 * Export sensor readings to CSV format
 */
export function exportToCSV(readings: SensorReading[], filename: string = "sensor-data.csv") {
  if (readings.length === 0) {
    console.warn("No data to export");
    return;
  }

  // Prepare CSV headers
  const headers = [
    "Timestamp",
    "Power (W)",
    "Energy (kWh)",
    "Voltage (V)",
    "Current (A)",
    "Power Factor",
    "Temperature (°C)",
    "Humidity (%)",
    "Pressure (hPa)",
    "Wind Speed (m/s)",
  ];

  // Prepare CSV rows
  const rows = readings.map((reading) => [
    new Date(reading.readingTime).toLocaleString(),
    reading.powerWatts || "",
    reading.energyKwh || "",
    reading.voltageAC || "",
    reading.currentAC || "",
    reading.powerFactor || "",
    reading.temperatureCelsius || "",
    reading.humidityPercent || "",
    reading.pressureHpa || "",
    reading.windSpeedMs || "",
  ]);

  // Create CSV content
  const csvContent = [
    headers.join(","),
    ...rows.map((row) =>
      row.map((cell) => {
        // Escape quotes and wrap in quotes if contains comma
        const cellStr = String(cell);
        if (cellStr.includes(",") || cellStr.includes('"') || cellStr.includes("\n")) {
          return `"${cellStr.replace(/"/g, '""')}"`;
        }
        return cellStr;
      })
    ),
  ]
    .map((row) => (Array.isArray(row) ? row.join(",") : row))
    .join("\n");

  // Create blob and download
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  downloadFile(blob, filename);
}

/**
 * Export sensor readings to JSON format
 */
export function exportToJSON(readings: SensorReading[], filename: string = "sensor-data.json") {
  if (readings.length === 0) {
    console.warn("No data to export");
    return;
  }

  const jsonContent = JSON.stringify(readings, null, 2);
  const blob = new Blob([jsonContent], { type: "application/json;charset=utf-8;" });
  downloadFile(blob, filename);
}

/**
 * Export sensor readings to TSV (Tab-Separated Values) format
 */
export function exportToTSV(readings: SensorReading[], filename: string = "sensor-data.tsv") {
  if (readings.length === 0) {
    console.warn("No data to export");
    return;
  }

  // Prepare TSV headers
  const headers = [
    "Timestamp",
    "Power (W)",
    "Energy (kWh)",
    "Voltage (V)",
    "Current (A)",
    "Power Factor",
    "Temperature (°C)",
    "Humidity (%)",
    "Pressure (hPa)",
    "Wind Speed (m/s)",
  ];

  // Prepare TSV rows
  const rows = readings.map((reading) => [
    new Date(reading.readingTime).toLocaleString(),
    reading.powerWatts || "",
    reading.energyKwh || "",
    reading.voltageAC || "",
    reading.currentAC || "",
    reading.powerFactor || "",
    reading.temperatureCelsius || "",
    reading.humidityPercent || "",
    reading.pressureHpa || "",
    reading.windSpeedMs || "",
  ]);

  // Create TSV content
  const tsvContent = [headers.join("\t"), ...rows.map((row) => row.join("\t"))].join("\n");

  // Create blob and download
  const blob = new Blob([tsvContent], { type: "text/tab-separated-values;charset=utf-8;" });
  downloadFile(blob, filename);
}

/**
 * Generate a summary report of sensor data
 */
export function generateSummaryReport(readings: SensorReading[]): string {
  if (readings.length === 0) {
    return "No data available for report";
  }

  const powers = readings
    .map((r) => Number(r.powerWatts))
    .filter((p) => !isNaN(p) && p !== null);
  const temps = readings
    .map((r) => Number(r.temperatureCelsius))
    .filter((t) => !isNaN(t) && t !== null);
  const energies = readings
    .map((r) => Number(r.energyKwh))
    .filter((e) => !isNaN(e) && e !== null);

  const avgPower = powers.length > 0 ? (powers.reduce((a, b) => a + b, 0) / powers.length).toFixed(2) : "N/A";
  const maxPower = powers.length > 0 ? Math.max(...powers).toFixed(2) : "N/A";
  const minPower = powers.length > 0 ? Math.min(...powers).toFixed(2) : "N/A";
  const avgTemp = temps.length > 0 ? (temps.reduce((a, b) => a + b, 0) / temps.length).toFixed(2) : "N/A";
  const maxTemp = temps.length > 0 ? Math.max(...temps).toFixed(2) : "N/A";
  const minTemp = temps.length > 0 ? Math.min(...temps).toFixed(2) : "N/A";
  const totalEnergy = energies.length > 0 ? Math.max(...energies).toFixed(2) : "N/A";

  return `
Solar Power Generation Report
Generated: ${new Date().toLocaleString()}
Data Points: ${readings.length}

Power Statistics:
- Average Power: ${avgPower} W
- Maximum Power: ${maxPower} W
- Minimum Power: ${minPower} W

Temperature Statistics:
- Average Temperature: ${avgTemp} °C
- Maximum Temperature: ${maxTemp} °C
- Minimum Temperature: ${minTemp} °C

Energy Statistics:
- Total Energy: ${totalEnergy} kWh

Data Range:
- Start: ${new Date(readings[0].readingTime).toLocaleString()}
- End: ${new Date(readings[readings.length - 1].readingTime).toLocaleString()}
`;
}

/**
 * Helper function to download a file
 */
function downloadFile(blob: Blob, filename: string) {
  const url = window.URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.setAttribute("download", filename);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  window.URL.revokeObjectURL(url);
}

/**
 * Format date for filename
 */
export function getDateForFilename(): string {
  const now = new Date();
  return now.toISOString().split("T")[0];
}
