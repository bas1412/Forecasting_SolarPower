import { useMemo, useState } from "react";
import { trpc } from "@/lib/trpc";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
} from "recharts";
import {
  Bell,
  Bolt,
  CheckCircle2,
  ChevronRight,
  Download,
  Database,
  Activity,
  CalendarDays,
  Droplets,
  Gauge,
  HelpCircle,
  LogOut,
  Thermometer,
  TrendingUp,
  UserCircle2,
  Wind,
  Zap,
} from "lucide-react";
import { exportToCSV, exportToJSON, exportToTSV, getDateForFilename } from "@/lib/exportUtils";
import { toast } from "sonner";
import { Link } from "wouter";

function parseAppDate(value?: Date | string | null) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) return new Date(value);
  return new Date(`${value}Z`);
}

function getLocalDateKey(date: Date) {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export default function History() {
  const [timeframe, setTimeframe] = useState<"hourly" | "daily" | "weekly">("hourly");
  const { data: researchStatus } = trpc.system.researchStatus.useQuery(undefined, {
    refetchInterval: 15000,
  });

  const historyQueryConfig = useMemo(() => {
    const endDate = new Date();

    if (timeframe === "hourly") {
      const startDate = new Date(endDate);
      startDate.setHours(startDate.getHours() - 24);
      return { limit: 2000, offset: 0, startDate, endDate };
    }

    if (timeframe === "daily") {
      const startDate = new Date(endDate);
      startDate.setHours(0, 0, 0, 0);
      return { limit: 5000, offset: 0, startDate, endDate };
    }

    const startDate = new Date(endDate);
    startDate.setDate(startDate.getDate() - 6);
    startDate.setHours(0, 0, 0, 0);
    return { limit: 2000, offset: 0, startDate, endDate };
  }, [timeframe]);

  const { data: sensorReadings } = trpc.sensors.list.useQuery(historyQueryConfig, {
    refetchInterval: 30000,
  });
  const { data: latestSensorReading } = trpc.sensors.latest.useQuery(undefined, {
    refetchInterval: 30000,
  });
  const { data: hourlySummaryRows } = trpc.sensors.hourlySummary.useQuery(
    {
      startDate: historyQueryConfig.startDate,
      endDate: historyQueryConfig.endDate,
    },
    {
      refetchInterval: 30000,
    }
  );

  const stats = useMemo(() => {
    if ((!sensorReadings || sensorReadings.length === 0) && (!hourlySummaryRows || hourlySummaryRows.length === 0)) {
      return {
        totalSensors: 0,
        avgPower: 0,
        avgTemp: 0,
        totalYield: 0,
        avgEfficiency: 0,
        peakOutput: 0,
      };
    }

    const summaryRows = hourlySummaryRows ?? [];
    const avgPower =
      summaryRows.length > 0
        ? summaryRows.reduce((sum: number, row: any) => sum + Number(row.power || 0), 0) / summaryRows.length
        : sensorReadings!.reduce((sum: number, reading: any) => sum + Number(reading.powerWatts || 0), 0) / sensorReadings!.length;
    const avgTemp =
      summaryRows.length > 0
        ? summaryRows.reduce((sum: number, row: any) => sum + Number(row.temperature || 0), 0) / summaryRows.length
        : sensorReadings!.reduce((sum: number, reading: any) => sum + Number(reading.temperatureCelsius || 0), 0) / sensorReadings!.length;
    const totalYield = (sensorReadings ?? []).reduce((sum: number, reading: any) => sum + Number(reading.energyKwh || 0), 0);
    const peakOutput =
      summaryRows.length > 0
        ? summaryRows.reduce((max: number, row: any) => Math.max(max, Number(row.power || 0)), 0)
        : sensorReadings!.reduce((max: number, reading: any) => Math.max(max, Number(reading.powerWatts || 0)), 0);
    const efficiencySource = summaryRows.length > 0 ? summaryRows : sensorReadings ?? [];
    const avgEfficiency =
      efficiencySource.reduce((sum: number, reading: any) => {
        const voltage = Number(reading.voltageAC ?? reading.voltage ?? 0);
        const current = Number(reading.currentAC ?? reading.current ?? 0);
        const power = Number(reading.powerWatts ?? reading.power ?? 0);
        const apparent = voltage * current;
        if (!apparent || !Number.isFinite(apparent)) return sum;
        return sum + Math.min(100, Math.max(0, (power / apparent) * 100));
      }, 0) / Math.max(efficiencySource.length, 1);

    return {
      totalSensors: (sensorReadings ?? []).length,
      avgPower,
      avgTemp,
      totalYield,
      avgEfficiency,
      peakOutput,
    };
  }, [sensorReadings, hourlySummaryRows]);

  const latestHistoricalSensor = useMemo(() => {
    if (latestSensorReading) return latestSensorReading;
    if (!sensorReadings || sensorReadings.length === 0) return null;
    return [...sensorReadings].sort((a: any, b: any) => {
      const aTime = parseAppDate(a.readingTime)?.getTime() || 0;
      const bTime = parseAppDate(b.readingTime)?.getTime() || 0;
      return bTime - aTime;
    })[0];
  }, [sensorReadings, latestSensorReading]);

  const sensorTrendCards = [
    { key: "voltage", title: "Voltage Trend", unit: "V", stroke: "#22d3ee", glow: "shadow-cyan-500/10" },
    { key: "current", title: "Current Trend", unit: "A", stroke: "#ec4899", glow: "shadow-pink-500/10" },
    { key: "powerFactor", title: "Power Factor Trend", unit: "pf", stroke: "#8b5cf6", glow: "shadow-violet-500/10" },
    { key: "temperature", title: "Temperature Trend", unit: "°C", stroke: "#fb7185", glow: "shadow-rose-500/10" },
    { key: "humidity", title: "Humidity Trend", unit: "%", stroke: "#60a5fa", glow: "shadow-sky-500/10" },
    { key: "wind", title: "Wind Speed Trend", unit: "m/s", stroke: "#34d399", glow: "shadow-emerald-500/10" },
  ] as const;

  const aggregatedTrendData = useMemo(() => {
    const normalizedRows =
      hourlySummaryRows && hourlySummaryRows.length > 0
        ? [...hourlySummaryRows].map((row: any) => {
            const parsed = parseAppDate(row.hour) ?? new Date();
            const voltage = Number(row.voltage || 0);
            const current = Number(row.current || 0);
            const power = Number(row.power || 0);
            return {
              dt: parsed,
              power,
              temperature: Number(row.temperature || 0),
              humidity: Number(row.humidity || 0),
              wind: Number(row.windSpeed || 0),
              voltage,
              current,
              powerFactor: Number(row.powerFactor || 0),
              efficiency: voltage * current > 0 ? Math.min(100, Math.max(0, (power / (voltage * current)) * 100)) : 0,
            };
          })
        : (sensorReadings ?? []).map((reading: any) => {
            const parsed = parseAppDate(reading.readingTime) ?? new Date();
            const voltage = Number(reading.voltageAC || 0);
            const current = Number(reading.currentAC || 0);
            const power = Number(reading.powerWatts || 0);
            return {
              dt: parsed,
              power,
              temperature: Number(reading.temperatureCelsius || 0),
              humidity: Number(reading.humidityPercent || 0),
              wind: Number(reading.windSpeedMs || 0),
              voltage,
              current,
              powerFactor: Number(reading.powerFactor || 0),
              efficiency: voltage * current > 0 ? Math.min(100, Math.max(0, (power / (voltage * current)) * 100)) : 0,
            };
          });

    if (normalizedRows.length === 0) {
      if (timeframe !== "weekly") return [];

      const end = new Date(historyQueryConfig.endDate);
      end.setHours(0, 0, 0, 0);
      return Array.from({ length: 7 }, (_, index) => {
        const date = new Date(end);
        date.setDate(end.getDate() - (6 - index));
        return {
          time: date.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
          power: 0,
          temperature: 0,
          humidity: 0,
          wind: 0,
          voltage: 0,
          current: 0,
          powerFactor: 0,
          efficiency: 0,
        };
      });
    }

    const sortedRows = [...normalizedRows].sort((a, b) => a.dt.getTime() - b.dt.getTime());

    if (timeframe !== "weekly") {
      return sortedRows.map((row) => ({
        time: row.dt.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" }),
        power: row.power,
        temperature: row.temperature,
        humidity: row.humidity,
        wind: row.wind,
        voltage: row.voltage,
        current: row.current,
        powerFactor: row.powerFactor,
        efficiency: row.efficiency,
      }));
    }

    const grouped = new Map<
      string,
      {
        label: string;
        count: number;
        power: number;
        temperature: number;
        humidity: number;
        wind: number;
        voltage: number;
        current: number;
        powerFactor: number;
        efficiency: number;
      }
    >();

    for (const row of sortedRows) {
      const key = getLocalDateKey(row.dt);
      const label = row.dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      const current = grouped.get(key) ?? {
        label,
        count: 0,
        power: 0,
        temperature: 0,
        humidity: 0,
        wind: 0,
        voltage: 0,
        current: 0,
        powerFactor: 0,
        efficiency: 0,
      };
      current.count += 1;
      current.power += row.power;
      current.temperature += row.temperature;
      current.humidity += row.humidity;
      current.wind += row.wind;
      current.voltage += row.voltage;
      current.current += row.current;
      current.powerFactor += row.powerFactor;
      current.efficiency += row.efficiency;
      grouped.set(key, current);
    }

    const aggregatedDays = Array.from(grouped.entries())
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([key, value]) => ({
        key,
        time: value.label,
        power: value.power / value.count,
        temperature: value.temperature / value.count,
        humidity: value.humidity / value.count,
        wind: value.wind / value.count,
        voltage: value.voltage / value.count,
        current: value.current / value.count,
        powerFactor: value.powerFactor / value.count,
        efficiency: value.efficiency / value.count,
      }));

    const end = new Date(historyQueryConfig.endDate);
    end.setHours(0, 0, 0, 0);
    const dailyMap = new Map(aggregatedDays.map((item) => [item.key, item]));

    return Array.from({ length: 7 }, (_, index) => {
      const date = new Date(end);
      date.setDate(end.getDate() - (6 - index));
      const key = getLocalDateKey(date);
      const label = date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
      return (
        dailyMap.get(key) ?? {
          key,
          time: label,
          power: 0,
          temperature: 0,
          humidity: 0,
          wind: 0,
          voltage: 0,
          current: 0,
          powerFactor: 0,
          efficiency: 0,
        }
      );
    });
  }, [hourlySummaryRows, timeframe, historyQueryConfig.endDate]);

  const sensorSummaryPie = useMemo(() => {
    if (!latestHistoricalSensor) return [];
    const rawItems = [
      {
        name: "Power",
        actual: Number(latestHistoricalSensor.powerWatts || 0),
        scaled: Number(latestHistoricalSensor.powerWatts || 0),
        unit: "W",
        color: "#f59e0b",
      },
      {
        name: "Voltage",
        actual: Number(latestHistoricalSensor.voltageAC || 0),
        scaled: Number(latestHistoricalSensor.voltageAC || 0),
        unit: "V",
        color: "#22d3ee",
      },
      {
        name: "Current",
        actual: Number(latestHistoricalSensor.currentAC || 0),
        scaled: Number(latestHistoricalSensor.currentAC || 0) * 100,
        unit: "A",
        color: "#ec4899",
      },
      {
        name: "P. Factor",
        actual: Number(latestHistoricalSensor.powerFactor || 0),
        scaled: Number(latestHistoricalSensor.powerFactor || 0) * 100,
        unit: "pf",
        color: "#8b5cf6",
      },
      {
        name: "Temp",
        actual: Number(latestHistoricalSensor.temperatureCelsius || 0),
        scaled: Number(latestHistoricalSensor.temperatureCelsius || 0),
        unit: "°C",
        color: "#fb7185",
      },
      {
        name: "Humidity",
        actual: Number(latestHistoricalSensor.humidityPercent || 0),
        scaled: Number(latestHistoricalSensor.humidityPercent || 0),
        unit: "%",
        color: "#60a5fa",
      },
      {
        name: "Wind",
        actual: Number(latestHistoricalSensor.windSpeedMs || 0),
        scaled: Number(latestHistoricalSensor.windSpeedMs || 0) * 10,
        unit: "m/s",
        color: "#34d399",
      },
    ];

    return rawItems.filter((item) => item.scaled > 0);
  }, [latestHistoricalSensor]);

  const historyRangeLabel = useMemo(() => {
    const start = historyQueryConfig.startDate;
    const end = historyQueryConfig.endDate;
    const first = start.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    const last = end.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    return first === last ? first : `${first} - ${last}`;
  }, [historyQueryConfig]);

  const loadedHistoryLabel = useMemo(() => {
    if (hourlySummaryRows && hourlySummaryRows.length > 0) {
      return `${hourlySummaryRows.length} hourly summaries loaded`;
    }
    return `${sensorReadings?.length || 0} rows loaded`;
  }, [hourlySummaryRows, sensorReadings]);

  const handleExportCSV = () => {
    if (!sensorReadings || sensorReadings.length === 0) {
      toast.error("No data to export");
      return;
    }
    exportToCSV(sensorReadings, `solar-data-${getDateForFilename()}.csv`);
    toast.success("Data exported as CSV");
  };

  const handleExportJSON = () => {
    if (!sensorReadings || sensorReadings.length === 0) {
      toast.error("No data to export");
      return;
    }
    exportToJSON(sensorReadings, `solar-data-${getDateForFilename()}.json`);
    toast.success("Data exported as JSON");
  };

  const handleExportTSV = () => {
    if (!sensorReadings || sensorReadings.length === 0) {
      toast.error("No data to export");
      return;
    }
    exportToTSV(sensorReadings, `solar-data-${getDateForFilename()}.tsv`);
    toast.success("Data exported as TSV");
  };

  return (
    <div className="min-h-screen bg-[#140d06] bg-[radial-gradient(circle_at_50%_0%,_#3c2a10_0%,_#140d06_60%)] text-[#f0e0d1]">
      <header className="fixed top-0 z-50 flex h-16 w-full items-center justify-between border-b border-white/10 bg-slate-950/40 px-6 shadow-[0_8px_32px_0_rgba(0,0,0,0.3)] backdrop-blur-xl lg:px-10">
        <div className="flex items-center gap-8">
          <span className="font-inter text-xl font-black uppercase tracking-tighter text-amber-500">SolarControl</span>
          <nav className="hidden items-center gap-6 md:flex">
            <Link className="font-medium text-slate-400 transition-all duration-300 hover:text-slate-100" href="/dashboard">Dashboard</Link>
            <Link className="border-b-2 border-amber-500 pb-1 font-bold text-amber-500" href="/history">History</Link>
          </nav>
        </div>
        <div className="flex items-center gap-4">
          <Bell className="h-5 w-5 cursor-pointer text-slate-400 transition-all duration-300 hover:text-slate-100" />
          <UserCircle2 className="h-5 w-5 cursor-pointer text-slate-400 transition-all duration-300 hover:text-slate-100" />
          <button className="rounded-xl bg-amber-500 px-5 py-2 text-[10px] font-black uppercase tracking-[0.22em] text-slate-950 transition-colors hover:bg-amber-400">
            Go Live
          </button>
        </div>
      </header>

      <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 flex-col border-r border-white/5 bg-slate-950/60 pb-8 pt-24 shadow-2xl shadow-black/50 backdrop-blur-2xl lg:flex">
        <div className="mb-8 px-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded bg-amber-500/20">
              <Bolt className="h-4 w-4 text-amber-500" />
            </div>
            <div>
              <div className="font-inter text-lg font-bold text-slate-100">HELIOS-1</div>
              <div className="text-xs font-medium uppercase tracking-widest text-slate-500">Active Monitoring</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 space-y-1">
          <Link className="flex items-center gap-3 px-6 py-3 text-sm font-medium text-slate-400 transition-colors duration-200 hover:bg-white/5 hover:text-white" href="/dashboard">
            <Activity className="h-4 w-4" />
            Dashboard
          </Link>
          <Link className="flex items-center gap-3 rounded-r-lg border-r-4 border-amber-500 bg-amber-500/10 px-6 py-3 text-sm font-medium text-amber-500" href="/history">
            <Database className="h-4 w-4" />
            History
          </Link>
        </nav>

        <div className="mt-auto px-6">
          <button
            onClick={handleExportCSV}
            className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-500 py-2.5 text-sm font-bold text-slate-950 transition-colors hover:bg-amber-400"
          >
            <Download className="h-4 w-4" />
            Export Data
          </button>
          <div className="mt-4 border-t border-white/5 pt-4">
            <div className="flex items-center gap-3 py-2 text-xs font-bold uppercase tracking-widest text-slate-500">
              <HelpCircle className="h-4 w-4" />
              Support
            </div>
            <div className="flex items-center gap-3 py-2 text-xs font-bold uppercase tracking-widest text-slate-500">
              <LogOut className="h-4 w-4" />
              Logout
            </div>
          </div>
        </div>
      </aside>

      <main className="px-6 pb-20 pt-24 lg:ml-64 lg:px-10">
        <header className="mb-8 flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
          <div>
            <nav className="mb-2 flex items-center gap-2 text-[12px] text-zinc-500">
              <span>SolarControl</span>
              <ChevronRight className="h-4 w-4" />
              <span className="text-amber-500">Historical Analysis</span>
            </nav>
            <h1 className="text-4xl font-bold tracking-tight text-[#f0e0d1]">Historical Analysis</h1>
          </div>
          <div className="flex items-center gap-4 rounded-2xl border border-white/10 bg-[#221a12]/80 p-2 backdrop-blur-md">
            <div className="px-4 py-2">
              <div className="mb-0.5 text-[10px] font-bold uppercase tracking-widest text-zinc-500">Date Range</div>
              <div className="flex items-center gap-2 text-sm text-[#f0e0d1]">
                <CalendarDays className="h-4 w-4 text-amber-400" />
                <span>{historyRangeLabel}</span>
                <span className="text-zinc-500">—</span>
                <span>{loadedHistoryLabel}</span>
              </div>
            </div>
            <button className="flex items-center gap-2 rounded-xl bg-amber-500 px-6 py-3 font-bold text-[#472a00] shadow-lg shadow-amber-500/20 transition-all hover:scale-[1.02]">
              <CalendarDays className="h-4 w-4" />
              Update Range
            </button>
          </div>
        </header>

        <section className="mb-8 grid grid-cols-1 gap-6 md:grid-cols-3">
          <div className="glass-card flex flex-col justify-between border-l-4 border-l-amber-500 p-6">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] uppercase tracking-widest text-zinc-400">Total Yield</span>
                <Bolt className="h-5 w-5 text-amber-400" />
              </div>
              <div className="text-4xl font-bold text-[#f0e0d1]">{stats.totalYield.toFixed(2)} <span className="text-2xl font-normal text-zinc-500">kWh</span></div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-sm text-cyan-300">
              <TrendingUp className="h-4 w-4" />
              <span>Live total from current page window</span>
            </div>
          </div>

          <div className="glass-card flex flex-col justify-between border-l-4 border-l-cyan-400 p-6">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] uppercase tracking-widest text-zinc-400">Avg Efficiency</span>
                <Gauge className="h-5 w-5 text-cyan-300" />
              </div>
              <div className="text-4xl font-bold text-[#f0e0d1]">{stats.avgEfficiency.toFixed(1)} <span className="text-2xl font-normal text-zinc-500">%</span></div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-sm text-cyan-300">
              <CheckCircle2 className="h-4 w-4" />
              <span>{researchStatus?.ok ? "Within cleaned backend range" : "Fallback mode active"}</span>
            </div>
          </div>

          <div className="glass-card flex flex-col justify-between border-l-4 border-l-sky-400 p-6">
            <div>
              <div className="mb-2 flex items-center justify-between">
                <span className="text-[12px] uppercase tracking-widest text-zinc-400">Peak Output</span>
                <Activity className="h-5 w-5 text-sky-300" />
              </div>
              <div className="text-4xl font-bold text-[#f0e0d1]">{stats.peakOutput.toFixed(1)} <span className="text-2xl font-normal text-zinc-500">W</span></div>
            </div>
            <div className="mt-4 flex items-center gap-2 text-sm text-zinc-400">
              <CalendarDays className="h-4 w-4" />
              <span>Derived from current historical page</span>
            </div>
          </div>
        </section>

        <section className="mb-8 grid grid-cols-2 gap-4 md:grid-cols-4 xl:grid-cols-7">
          <div className="glass-card border-l-4 border-l-amber-500 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Power</span>
              <Zap className="h-4 w-4 text-amber-400" />
            </div>
            <div className="text-3xl font-bold text-[#f0e0d1]">{latestHistoricalSensor ? Number(latestHistoricalSensor.powerWatts || 0).toFixed(1) : "--"} <span className="text-sm font-normal text-zinc-500">W</span></div>
          </div>
          <div className="glass-card border-l-4 border-l-cyan-400 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Voltage</span>
              <Bolt className="h-4 w-4 text-cyan-300" />
            </div>
            <div className="text-3xl font-bold text-[#f0e0d1]">{latestHistoricalSensor ? Number(latestHistoricalSensor.voltageAC || 0).toFixed(1) : "--"} <span className="text-sm font-normal text-zinc-500">V</span></div>
          </div>
          <div className="glass-card border-l-4 border-l-fuchsia-400 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Current</span>
              <Activity className="h-4 w-4 text-fuchsia-300" />
            </div>
            <div className="text-3xl font-bold text-[#f0e0d1]">{latestHistoricalSensor ? Number(latestHistoricalSensor.currentAC || 0).toFixed(2) : "--"} <span className="text-sm font-normal text-zinc-500">A</span></div>
          </div>
          <div className="glass-card border-l-4 border-l-violet-400 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">P. Factor</span>
              <Gauge className="h-4 w-4 text-violet-300" />
            </div>
            <div className="text-3xl font-bold text-[#f0e0d1]">{latestHistoricalSensor ? Number(latestHistoricalSensor.powerFactor || 0).toFixed(2) : "--"} <span className="text-sm font-normal text-zinc-500">pf</span></div>
          </div>
          <div className="glass-card border-l-4 border-l-rose-400 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Temp</span>
              <Thermometer className="h-4 w-4 text-rose-300" />
            </div>
            <div className="text-3xl font-bold text-[#f0e0d1]">{latestHistoricalSensor ? Number(latestHistoricalSensor.temperatureCelsius || 0).toFixed(1) : "--"} <span className="text-sm font-normal text-zinc-500">°C</span></div>
          </div>
          <div className="glass-card border-l-4 border-l-sky-400 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Humidity</span>
              <Droplets className="h-4 w-4 text-sky-300" />
            </div>
            <div className="text-3xl font-bold text-[#f0e0d1]">{latestHistoricalSensor ? Number(latestHistoricalSensor.humidityPercent || 0).toFixed(0) : "--"} <span className="text-sm font-normal text-zinc-500">%</span></div>
          </div>
          <div className="glass-card border-l-4 border-l-emerald-400 p-4">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[11px] uppercase tracking-[0.2em] text-zinc-500">Wind</span>
              <Wind className="h-4 w-4 text-emerald-300" />
            </div>
            <div className="text-3xl font-bold text-[#f0e0d1]">{latestHistoricalSensor ? Number(latestHistoricalSensor.windSpeedMs || 0).toFixed(1) : "--"} <span className="text-sm font-normal text-zinc-500">m/s</span></div>
          </div>
        </section>

        <section className="glass-card mb-8 p-8">
          <div className="mb-8 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h3 className="text-2xl font-semibold text-[#f0e0d1]">Power Generation by Sensor</h3>
              <p className="text-zinc-400">Historical trend of measured values from the current sensor window.</p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex rounded-xl border border-white/10 bg-white/5 p-1">
                <button
                  onClick={() => setTimeframe("hourly")}
                  className={`rounded-lg px-4 py-2 text-sm transition-colors ${timeframe === "hourly" ? "bg-amber-500 font-bold text-[#472a00]" : "text-zinc-400 hover:text-zinc-100"}`}
                >
                  Hourly
                </button>
                <button
                  onClick={() => setTimeframe("daily")}
                  className={`rounded-lg px-4 py-2 text-sm transition-colors ${timeframe === "daily" ? "bg-amber-500 font-bold text-[#472a00]" : "text-zinc-400 hover:text-zinc-100"}`}
                >
                  Daily
                </button>
                <button
                  onClick={() => setTimeframe("weekly")}
                  className={`rounded-lg px-4 py-2 text-sm transition-colors ${timeframe === "weekly" ? "bg-amber-500 font-bold text-[#472a00]" : "text-zinc-400 hover:text-zinc-100"}`}
                >
                  Weekly
                </button>
              </div>
              <button
                onClick={handleExportCSV}
                className="rounded-full border border-cyan-400/20 bg-cyan-400/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-cyan-200 transition-colors hover:bg-cyan-400/15"
              >
                Export CSV
              </button>
              <button
                onClick={handleExportJSON}
                className="rounded-full border border-violet-400/20 bg-violet-400/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-violet-200 transition-colors hover:bg-violet-400/15"
              >
                Export JSON
              </button>
              <button
                onClick={handleExportTSV}
                className="rounded-full border border-emerald-400/20 bg-emerald-400/10 px-4 py-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-emerald-200 transition-colors hover:bg-emerald-400/15"
              >
                Export TSV
              </button>
              <div className="rounded-full border border-white/10 bg-white/5 px-4 py-2 text-[11px] uppercase tracking-[0.22em] text-zinc-400">
                {aggregatedTrendData.length} grouped points
              </div>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.45fr_0.95fr]">
            <div className="h-[360px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={aggregatedTrendData} barGap={6} barCategoryGap="22%">
                  <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.08)" vertical={false} />
                  <XAxis dataKey="time" stroke="rgba(240,224,209,0.42)" tick={{ fill: "rgba(240,224,209,0.62)", fontSize: 11 }} tickLine={false} />
                  <YAxis stroke="rgba(240,224,209,0.42)" tick={{ fill: "rgba(240,224,209,0.62)", fontSize: 11 }} tickLine={false} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "rgba(20,13,6,0.96)",
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: "18px",
                    }}
                    labelStyle={{ color: "#f0e0d1", fontWeight: 700 }}
                  />
                  <Legend wrapperStyle={{ color: "#f0e0d1", fontSize: "12px" }} />
                  <Bar dataKey="power" name="Power (W)" fill="#f59e0b" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="temperature" name="Temp (°C)" fill="#fb7185" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="humidity" name="Humidity (%)" fill="#60a5fa" radius={[8, 8, 0, 0]} />
                  <Bar dataKey="wind" name="Wind (m/s)" fill="#34d399" radius={[8, 8, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>

            <div className="glass-card border border-white/10 p-5">
              <div className="mb-4">
                <h4 className="text-lg font-semibold text-[#f0e0d1]">Sensor Snapshot Summary</h4>
                <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Latest measured sensor values</p>
              </div>
              <div className="h-[250px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <PieChart>
                    <Pie
                      data={sensorSummaryPie}
                      dataKey="scaled"
                      nameKey="name"
                      innerRadius={58}
                      outerRadius={90}
                      paddingAngle={3}
                      stroke="rgba(20,13,6,0.95)"
                      strokeWidth={2}
                    >
                      {sensorSummaryPie.map((entry) => (
                        <Cell key={entry.name} fill={entry.color} />
                      ))}
                    </Pie>
                    <Tooltip
                      formatter={(_value: number, _name, item: any) => {
                        const decimals = item?.payload?.unit === "A" || item?.payload?.unit === "pf" ? 2 : 1;
                        const actual = Number(item?.payload?.actual || 0).toFixed(decimals);
                        return [`${actual} ${item?.payload?.unit}`, item?.payload?.name];
                      }}
                      contentStyle={{
                        backgroundColor: "rgba(20,13,6,0.96)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: "18px",
                      }}
                      labelStyle={{ color: "#f0e0d1", fontWeight: 700 }}
                    />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
                {sensorSummaryPie.map((item) => (
                  <div key={item.name} className="flex items-center justify-between rounded-2xl border border-white/10 bg-white/5 px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                      <span className="text-sm text-zinc-300">{item.name}</span>
                    </div>
                    <span className="text-sm font-semibold text-[#f0e0d1]">
                      {item.actual.toFixed(item.unit === "A" || item.unit === "pf" ? 2 : 1)} {item.unit}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </section>

        {!researchStatus?.ok ? (
          <div className="mb-8 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-sm text-amber-100">
            History data may look incomplete while FastAPI/Elasticsearch is unavailable. Check ports <span className="font-semibold">8010</span> and <span className="font-semibold">9200</span>.
          </div>
        ) : null}

        <section className="grid grid-cols-1 gap-6 xl:grid-cols-2">
          {sensorTrendCards.map((card) => (
            <div
              key={card.key}
              className={`glass-card overflow-hidden border border-white/10 p-6 shadow-[0_10px_28px_rgba(0,0,0,0.24)] ${card.glow}`}
            >
              <div className="mb-4 flex items-center justify-between">
                <div>
                  <h4 className="text-lg font-semibold text-[#f0e0d1]">{card.title}</h4>
                  <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">Historical sensor trend</p>
                </div>
                <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] uppercase tracking-[0.18em] text-zinc-400">
                  {card.unit}
                </span>
              </div>
              <div className="h-[230px] w-full">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={aggregatedTrendData}>
                    <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.06)" vertical={false} />
                    <XAxis dataKey="time" stroke="rgba(240,224,209,0.32)" tick={{ fill: "rgba(240,224,209,0.58)", fontSize: 10 }} tickLine={false} />
                    <YAxis stroke="rgba(240,224,209,0.32)" tick={{ fill: "rgba(240,224,209,0.58)", fontSize: 10 }} tickLine={false} />
                    <Tooltip
                      contentStyle={{
                        backgroundColor: "rgba(20,13,6,0.96)",
                        border: "1px solid rgba(255,255,255,0.12)",
                        borderRadius: "18px",
                      }}
                      labelStyle={{ color: "#f0e0d1", fontWeight: 700 }}
                    />
                    <Line
                      type="monotone"
                      dataKey={card.key}
                      stroke={card.stroke}
                      strokeWidth={3}
                      dot={false}
                      activeDot={{ r: 4, fill: card.stroke, stroke: "#140d06", strokeWidth: 2 }}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
              <div className="mt-4 text-sm text-zinc-400">
                Latest:{" "}
                <span className="font-semibold text-[#f0e0d1]">
                  {latestHistoricalSensor
                    ? Number(
                        card.key === "voltage"
                          ? latestHistoricalSensor.voltageAC || 0
                          : card.key === "current"
                            ? latestHistoricalSensor.currentAC || 0
                            : card.key === "powerFactor"
                              ? latestHistoricalSensor.powerFactor || 0
                              : card.key === "temperature"
                                ? latestHistoricalSensor.temperatureCelsius || 0
                                : card.key === "humidity"
                                  ? latestHistoricalSensor.humidityPercent || 0
                                  : latestHistoricalSensor.windSpeedMs || 0
                      ).toFixed(card.key === "current" || card.key === "powerFactor" ? 2 : 1)
                    : "--"}{" "}
                  {card.unit}
                </span>
              </div>
            </div>
          ))}
        </section>
      </main>
    </div>
  );
}
