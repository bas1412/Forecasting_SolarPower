import { useMemo } from "react";
import { trpc } from "@/lib/trpc";
import { Card, CardTitle } from "@/components/ui/card";
import { Activity, AlertTriangle, ArrowDownRight, ArrowUpRight, BellRing, Camera, Cloud, Droplets, Gauge, History, ImageIcon, LayoutDashboard, Minus, Thermometer, UserCircle2, Wind, Zap } from "lucide-react";
import { Link as RouterLink } from "wouter";

interface SensorReading {
  id: number;
  readingTime: Date | string;
  powerWatts: string;
  temperatureCelsius: string;
  humidityPercent: number;
  windSpeedMs: string;
  voltageAC?: string | null;
  currentAC?: string | null;
  energyKwh?: string | null;
  powerFactor?: string | null;
  pressureHpa?: string | null;
}

interface SkyImage {
  id: number;
  imageUrl: string;
  mimeType?: string | null;
  captureTime?: Date | string | null;
  createdAt?: Date | string | null;
}

interface ForecastItem {
  time: string;
  power: number;
  confidence: number;
  trend: "up" | "down" | "flat";
  model?: string;
  rawPower?: number;
  rangeAdjusted?: boolean;
  windowMinutes?: number;
}

function parseAppDate(value?: Date | string | null) {
  if (!value) return null;
  if (value instanceof Date) return value;
  if (/[zZ]|[+-]\d{2}:\d{2}$/.test(value)) return new Date(value);
  return new Date(`${value}Z`);
}

function formatDateTime(value?: Date | string | null) {
  if (!value) return "Waiting for latest update";
  const parsed = parseAppDate(value);
  return parsed ? parsed.toLocaleString() : "Waiting for latest update";
}

function formatAge(ageMs: number | null) {
  if (ageMs === null || !Number.isFinite(ageMs)) return "waiting";
  const seconds = Math.max(0, Math.floor(ageMs / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m ago` : `${hours}h ago`;
}

function parseCloudVectorData(value?: string | null) {
  if (!value) return null;
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function getCloudStatus(coverage: number) {
  if (coverage < 25) return { label: "Clear sky", tone: "text-cyan-300" };
  if (coverage < 60) return { label: "Partly cloudy", tone: "text-sky-300" };
  return { label: "Overcast", tone: "text-blue-300" };
}

function isMlCloudVector(cloudVector: Record<string, unknown> | null) {
  if (!cloudVector) return false;
  const analysis = String(cloudVector.analysis || "");
  return analysis === "fixed-building-mask-patch-rf";
}

function getForecastTrend(currentPower: number, forecastPower: number): ForecastItem["trend"] {
  if (forecastPower > currentPower + 0.2) return "up";
  if (forecastPower < currentPower - 0.2) return "down";
  return "flat";
}

function isActiveCollectionTime(timestamp: number) {
  const now = new Date(timestamp);
  const minutes = now.getHours() * 60 + now.getMinutes();
  return minutes >= 5 * 60 + 30 && minutes <= 18 * 60 + 30;
}

export default function Dashboard() {
  const { data: latestSensor, isLoading: sensorLoading } = trpc.sensors.latest.useQuery(undefined, {
    refetchInterval: 5000,
  });
  const { data: researchStatus } = trpc.system.researchStatus.useQuery(undefined, {
    refetchInterval: 15000,
  });
  const { data: latestCloud } = trpc.clouds.latest.useQuery(undefined, {
    refetchInterval: 10000,
  });
  const { data: baselineForecast } = trpc.forecast.getBaselineForecast.useQuery(
    { hoursBack: 2 },
    { refetchInterval: 30000, placeholderData: (previousData) => previousData }
  );
  const { data: stableWindowForecast } = trpc.forecast.getStableWindowForecast.useQuery(
    { hoursBack: 2 },
    { refetchInterval: 30000, placeholderData: (previousData) => previousData }
  );
  const { data: randomForestForecast } = trpc.forecast.getRandomForestForecast.useQuery(
    { hoursBack: 2 },
    { refetchInterval: 30000, placeholderData: (previousData) => previousData }
  );
  const { data: recentImages, isLoading: imagesLoading } = trpc.images.list.useQuery(
    { limit: 1, offset: 0 },
    { refetchInterval: 10000 }
  );
  const latestImage = recentImages?.[0] as SkyImage | undefined;
  const latestImageTime = latestImage?.captureTime || latestImage?.createdAt;

  const currentPower = latestSensor ? Number(latestSensor.powerWatts) : 0;
  const currentTemp = latestSensor ? Number(latestSensor.temperatureCelsius) : 0;
  const currentHumidity = latestSensor ? Number(latestSensor.humidityPercent) : 0;
  const currentWindSpeed = latestSensor ? Number(latestSensor.windSpeedMs) : 0;
  const currentVoltage = latestSensor?.voltageAC ? Number(latestSensor.voltageAC) : 0;
  const currentCurrent = latestSensor?.currentAC ? Number(latestSensor.currentAC) : 0;
  const currentPowerFactor = latestSensor?.powerFactor ? Number(latestSensor.powerFactor) : 0;

  const cloudCoverage = latestCloud ? Number((latestCloud as any).cloudCoveragePercent || 0) : 0;
  const cloudVector = parseCloudVectorData((latestCloud as any)?.cloudVectorData);
  const cloudCoverageConfidence = String(cloudVector?.cloudCoverageConfidence || "experimental");
  const imageDatasetPhase = String(cloudVector?.datasetPhase || "legacy_or_unknown");
  const cameraSetup = String(cloudVector?.cameraSetup || "Pi Camera Module 3 Wide");
  const usesMlCloudVector = isMlCloudVector(cloudVector);
  const isExperimentalCloud = cloudCoverageConfidence !== "calibrated";
  const cloudAlgorithm = String(cloudVector?.analysis || "legacy_or_unknown");
  const cloudUsesLegacyMask = cloudAlgorithm === "opencv-hsv-blue-sky-mask";
  const legacyCloudCoverageEnabled = cloudVector?.legacyCloudCoverageEnabled !== false;
  const cloudDisplayStatus = usesMlCloudVector
    ? {
        ...getCloudStatus(cloudCoverage),
        label: getCloudStatus(cloudCoverage).label,
      }
    : isExperimentalCloud
      ? {
          label: legacyCloudCoverageEnabled ? "Legacy estimate only" : "Legacy estimate disabled",
          tone: "text-amber-200",
        }
      : getCloudStatus(cloudCoverage);

  const latestSensorTime = parseAppDate(latestSensor?.readingTime);
  const latestImageDate = parseAppDate(latestImageTime);
  const nowMs = Date.now();
  const sensorAgeMs = latestSensorTime ? nowMs - latestSensorTime.getTime() : null;
  const imageAgeMs = latestImageDate ? nowMs - latestImageDate.getTime() : null;
  const isCollectionWindow = isActiveCollectionTime(nowMs);
  const sensorStale = isCollectionWindow && (!latestSensorTime || (sensorAgeMs ?? 0) > 2 * 60 * 1000);
  const imageStale = isCollectionWindow && (!latestImageDate || (imageAgeMs ?? 0) > 3 * 60 * 1000);
  const latestSensorLabel = formatAge(sensorAgeMs);
  const latestImageLabel = formatAge(imageAgeMs);
  const liveStatusLabel = sensorLoading
    ? "Syncing data"
    : sensorStale
      ? "Data delayed"
      : isCollectionWindow
        ? "Collection active"
        : "Collection standby";
  const liveStatusTone = sensorStale
    ? "border-rose-500/25 bg-rose-500/10 text-rose-200"
    : isCollectionWindow
      ? "border-emerald-500/20 bg-emerald-500/10 text-emerald-200"
      : "border-slate-600/60 bg-slate-800/50 text-slate-300";

  const forecastSource = stableWindowForecast?.items?.length
    ? "stable-window"
    : randomForestForecast?.items?.length
      ? "random-forest"
      : baselineForecast?.items?.length
        ? "ridge"
        : "fallback";

  const forecastQuality: any =
    forecastSource === "stable-window"
      ? stableWindowForecast?.quality
      : forecastSource === "random-forest"
        ? randomForestForecast?.quality
        : baselineForecast?.quality;

  const forecastNote =
    forecastSource === "stable-window"
      ? stableWindowForecast?.note
      : forecastSource === "random-forest"
        ? randomForestForecast?.quality?.note
        : baselineForecast?.quality?.note;

  const forecastData = useMemo<ForecastItem[]>(() => {
    if (stableWindowForecast?.items?.length) {
      return stableWindowForecast.items.map((item: any) => ({
        time: item.time,
        power: item.power,
        confidence: item.confidence,
        trend: item.trend,
        model: item.model,
        rawPower: item.rawPower,
        rangeAdjusted: item.rangeAdjusted,
        windowMinutes: item.windowMinutes,
      }));
    }

    if (randomForestForecast?.items?.length) {
      return randomForestForecast.items.map((item: any) => ({
        time: item.time,
        power: item.power,
        confidence: item.confidence,
        trend: item.trend,
        model: item.model,
        rawPower: item.rawPower,
        rangeAdjusted: item.rangeAdjusted,
        windowMinutes: item.windowMinutes,
      }));
    }

    if (baselineForecast?.items?.length) {
      return baselineForecast.items.map((item: any) => ({
        time: item.time,
        power: item.power,
        confidence: item.confidence,
        trend: item.trend,
        model: item.model,
        rawPower: item.rawPower,
        rangeAdjusted: item.rangeAdjusted,
        windowMinutes: item.windowMinutes,
      }));
    }

    const basePower = latestSensor ? Number(latestSensor.powerWatts) : 0;
    const points = [
      { time: "+5 min", power: Math.max(0, Math.round(basePower * 0.95)), confidence: 0.85 },
      { time: "+10 min", power: Math.max(0, Math.round(basePower * 0.9)), confidence: 0.78 },
      { time: "+15 min", power: Math.max(0, Math.round(basePower * 0.85)), confidence: 0.72 },
    ];

    return points.map((item) => ({
      ...item,
      trend: getForecastTrend(basePower, item.power),
      model: "Fallback",
    }));
  }, [baselineForecast, latestSensor, randomForestForecast, stableWindowForecast]);

  const forecastRangeGuardActive =
    forecastData.some((forecast) => forecast.rangeAdjusted) ||
    Boolean(forecastQuality && "rangeGuardApplied" in forecastQuality && forecastQuality.rangeGuardApplied);

  const kpiCards = [
    { label: "Power", value: currentPower.toFixed(1), unit: "W", source: "PZEM-004T", icon: Zap, iconColor: "text-yellow-300", valueColor: "text-yellow-200" },
    { label: "Voltage", value: currentVoltage.toFixed(1), unit: "V", source: "PZEM-004T", icon: Activity, iconColor: "text-cyan-300", valueColor: "text-cyan-200" },
    { label: "Current", value: currentCurrent.toFixed(2), unit: "A", source: "PZEM-004T", icon: Gauge, iconColor: "text-pink-300", valueColor: "text-pink-200" },
    { label: "P. Factor", value: currentPowerFactor.toFixed(2), unit: "PF", source: "PZEM-004T", icon: Gauge, iconColor: "text-violet-300", valueColor: "text-violet-200" },
    { label: "Temp", value: currentTemp.toFixed(1), unit: "°C", source: "AHT20/BMP280", icon: Thermometer, iconColor: "text-red-300", valueColor: "text-red-200" },
    { label: "Humidity", value: currentHumidity.toFixed(0), unit: "%", source: "AHT20/BMP280", icon: Droplets, iconColor: "text-blue-300", valueColor: "text-blue-200" },
    { label: "Wind", value: currentWindSpeed.toFixed(1), unit: "m/s", source: "RS-FSA-N01", icon: Wind, iconColor: "text-emerald-300", valueColor: "text-emerald-200" },
    { label: "Cloud", value: isExperimentalCloud ? "--" : cloudCoverage.toFixed(1), unit: isExperimentalCloud ? "" : "%", source: isExperimentalCloud ? "Legacy OpenCV estimate" : "Camera", icon: Cloud, iconColor: "text-sky-300", valueColor: "text-sky-200" },
  ];

  const topKpiCards = kpiCards.filter((card) => card.label !== "Cloud");
  const maxForecastPower = Math.max(20, currentPower, ...forecastData.map((forecast) => forecast.power));
  const powerPercent = Math.min(100, Math.max(4, (currentPower / 20) * 100));

  return (
    <div className="h-screen overflow-hidden bg-[#19120a] text-[#f0e0d1]">
      <aside className="fixed left-0 top-0 z-40 hidden h-screen w-64 border-r border-white/10 bg-slate-950/80 backdrop-blur-xl md:flex md:flex-col">
        <div className="px-6 py-8">
          <h1 className="text-xl font-black tracking-tight text-amber-500">HELIOS CONTROL</h1>
          <p className="mt-1 text-[10px] font-bold uppercase tracking-[0.28em] text-slate-500">Mission Control</p>
        </div>
        <nav className="flex-1 space-y-1">
          <RouterLink className="flex items-center gap-3 border-r-2 border-amber-500 bg-amber-500/10 px-6 py-4 text-sm font-semibold text-amber-500" href="/dashboard">
            <LayoutDashboard className="h-4 w-4" />
            <span>Dashboard</span>
          </RouterLink>
          <RouterLink className="flex items-center gap-3 px-6 py-4 text-sm font-semibold text-slate-400 transition-all hover:bg-white/5 hover:text-slate-100" href="/history">
            <History className="h-4 w-4" />
            <span>History</span>
          </RouterLink>
        </nav>
        <div className="flex items-center gap-3 border-t border-white/10 p-6">
          <div className="flex h-10 w-10 items-center justify-center rounded-full border border-amber-500/30 bg-amber-500/10 text-amber-400">
            <UserCircle2 className="h-6 w-6" />
          </div>
          <div className="min-w-0">
            <p className="truncate text-xs font-bold text-slate-100">OPERATOR_04</p>
            <p className="text-[10px] font-black uppercase tracking-[0.22em] text-amber-500">Level 3 Clearance</p>
          </div>
        </div>
      </aside>

      <main className="h-screen overflow-hidden md:ml-64">
        <header className="z-30 flex h-16 items-center justify-between border-b border-white/5 bg-slate-950/40 px-5 backdrop-blur-lg md:px-10">
          <div className="flex items-center gap-6">
            <span className="text-[10px] font-bold uppercase tracking-[0.28em] text-amber-500">System Monitor</span>
            <div className={`flex items-center gap-2 rounded-full border px-3 py-1 ${sensorStale ? "border-rose-500/25 bg-rose-500/10 text-rose-200" : "border-green-500/20 bg-green-500/10 text-green-400"}`}>
              <div className={`h-1.5 w-1.5 rounded-full ${sensorStale ? "bg-rose-400" : "bg-green-500"}`} />
              <span className="text-[10px] font-bold uppercase tracking-[0.18em]">{sensorStale ? "Live feed stale" : "Live connection stable"}</span>
            </div>
          </div>
          <div className="flex items-center gap-4 md:gap-6">
            <div className="hidden gap-4 md:flex">
              <BellRing className="h-4 w-4 cursor-pointer text-slate-400 transition-colors hover:text-amber-400" />
              <UserCircle2 className="h-4 w-4 cursor-pointer text-slate-400 transition-colors hover:text-amber-400" />
            </div>
            <div className="flex items-center gap-2 rounded-full border border-white/10 bg-[#19120a]/45 px-3 py-1.5 backdrop-blur-xl">
              <div className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
              <span className="text-xs text-zinc-300">Live data</span>
            </div>
            <button className="rounded-lg bg-amber-500 px-4 py-1.5 text-[10px] font-black uppercase tracking-[0.28em] text-[#472a00] transition-transform hover:scale-95">Live View</button>
          </div>
        </header>

        <div className="h-[calc(100vh-64px)] overflow-hidden bg-[radial-gradient(circle_at_top_right,_rgba(245,158,11,0.08),_transparent_40%),radial-gradient(circle_at_top_left,_rgba(255,255,255,0.03),_transparent_35%)] p-4 md:px-5 md:py-5">
          <div className="flex h-full w-full flex-col gap-3">
            <section className="pb-1">
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-[0.35em] text-amber-400/80">Solar Monitoring</p>
              <h1 className="text-[1.55rem] font-bold tracking-tight text-[#f0e0d1] md:text-[1.85rem]">SolarControl Dashboard</h1>
              <p className="mt-1 max-w-3xl text-[11px] text-zinc-400">Real-time sensor monitoring, sky imaging, cloud estimation, and short-term power forecasting.</p>
            </section>

            <section className="flex flex-wrap items-center gap-2">
              <div className={`rounded-full border px-3 py-1 text-[11px] ${liveStatusTone}`}>{liveStatusLabel}</div>
              <div className="rounded-full border border-white/10 bg-[#19120a]/45 px-3 py-1 text-[11px] text-zinc-300 backdrop-blur-xl">Sensor <span className="text-[#f0e0d1]">{latestSensorLabel}</span></div>
              <div className="rounded-full border border-white/10 bg-[#19120a]/45 px-3 py-1 text-[11px] text-zinc-300 backdrop-blur-xl">Image <span className="text-[#f0e0d1]">{latestImageLabel}</span></div>
              <div className={`flex items-center gap-2 rounded-full border px-3 py-1 text-[11px] ${researchStatus?.ok ? "border-cyan-400/20 bg-cyan-400/10 text-cyan-200" : "border-amber-400/25 bg-amber-400/10 text-amber-200"}`}>
                {!researchStatus?.ok ? <AlertTriangle className="h-3.5 w-3.5" /> : <Activity className="h-3.5 w-3.5" />}
                <span>{researchStatus?.ok ? "Data pipeline ready" : "Research services unavailable"}</span>
              </div>
            </section>

            {sensorStale || imageStale ? (
              <div className="rounded-3xl border border-rose-400/25 bg-rose-400/10 px-4 py-2 text-xs text-rose-100">
                Pi updates are delayed during the collection window. Latest sensor: <span className="font-semibold">{latestSensorLabel}</span>, latest image: <span className="font-semibold">{latestImageLabel}</span>. Check <span className="font-semibold">solar-monitor.service</span> and verify the current notebook target IP.
              </div>
            ) : null}
            {!isCollectionWindow && latestSensorTime ? (
              <div className="rounded-3xl border border-white/10 bg-[#19120a]/45 px-4 py-2 text-xs text-zinc-300 backdrop-blur-xl">Collection is on standby. Automatic capture runs from <span className="font-semibold text-zinc-100">05:30</span> to <span className="font-semibold text-zinc-100">18:30</span>.</div>
            ) : null}
            {!researchStatus?.ok ? (
              <div className="rounded-3xl border border-amber-400/20 bg-amber-400/10 px-4 py-2 text-xs text-amber-100">Historical data may be incomplete while FastAPI or Elasticsearch is unavailable. Check ports <span className="font-semibold">8010</span> and <span className="font-semibold">9200</span>.</div>
            ) : null}

            <section className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
              {topKpiCards.map((card) => {
                const Icon = card.icon;
                const progressWidth =
                  card.label === "Power"
                    ? powerPercent
                    : card.label === "Voltage"
                      ? Math.min(100, (currentVoltage / 260) * 100)
                      : card.label === "Current"
                        ? Math.min(100, (currentCurrent / 100) * 100)
                        : card.label === "P. Factor"
                          ? Math.min(100, currentPowerFactor * 100)
                          : card.label === "Temp"
                            ? Math.min(100, (currentTemp / 60) * 100)
                            : card.label === "Humidity"
                              ? Math.min(100, currentHumidity)
                              : Math.min(100, (currentWindSpeed / 10) * 100);

                return (
                  <Card key={card.label} className="rounded-[0.95rem] border border-white/10 bg-[#261e15]/40 p-2.5 shadow-[0_20px_50px_rgba(0,0,0,0.28)] backdrop-blur-xl">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[10px] font-bold uppercase tracking-[0.22em] text-zinc-400">{card.label}</span>
                      <Icon className={`h-4 w-4 ${card.iconColor}`} />
                    </div>
                    <div className="flex items-end gap-2">
                      <span className={`text-[1.35rem] font-bold tracking-tight ${card.valueColor}`}>{card.value}</span>
                      <span className="pb-0.5 text-[10px] text-zinc-500">{card.unit}</span>
                    </div>
                    <div className="mt-1.5 text-[9px] text-zinc-500">{card.source}</div>
                    <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                      <div className="h-full rounded-full bg-amber-500" style={{ width: `${Math.min(100, Math.max(4, progressWidth))}%` }} />
                    </div>
                  </Card>
                );
              })}
            </section>

            <section className="grid min-h-0 flex-1 grid-cols-12 gap-3 items-stretch">
              <Card className="col-span-12 flex min-h-0 flex-col overflow-hidden rounded-[1.35rem] border border-white/10 bg-[#261e15]/40 shadow-[0_20px_50px_rgba(0,0,0,0.28)] backdrop-blur-xl xl:col-span-10">
                <div className="flex items-center justify-between border-b border-white/5 px-5 py-3">
                  <div className="flex items-center gap-3">
                    <Camera className="h-5 w-5 text-amber-500" />
                    <div>
                      <CardTitle className="text-[1rem] font-semibold text-[#f0e0d1]">Sky Monitoring Station</CardTitle>
                      <p className="text-[10px] text-zinc-500">Node: Pi-Solar-01</p>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    <span className="rounded-full border border-red-500/30 bg-red-500/20 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-red-300">Live Feed</span>
                    <span className="rounded-full border border-white/10 bg-white/5 px-3 py-1 text-[10px] font-bold uppercase tracking-[0.2em] text-slate-300">{cameraSetup}</span>
                  </div>
                </div>
                <div className="relative min-h-0 flex-1 bg-zinc-950">
                  {imagesLoading ? (
                    <div className="flex h-full items-center justify-center text-sm text-zinc-400">Loading latest image...</div>
                  ) : latestImage?.imageUrl ? (
                    <div className="flex h-full w-full items-center justify-center bg-zinc-950">
                      <img src={latestImage.imageUrl} alt="Latest sky capture from Raspberry Pi" className="h-full w-full object-contain object-center opacity-95" />
                    </div>
                  ) : (
                    <div className="flex h-full flex-col items-center justify-center gap-2 text-zinc-400"><ImageIcon className="h-8 w-8 text-zinc-600" /><p className="text-sm">No sky image received yet</p></div>
                  )}

                  <div className="absolute left-3 top-3 z-10 flex flex-wrap gap-2">
                    <span className="inline-flex items-center gap-1 rounded-full bg-amber-500 px-3 py-1 text-[10px] font-bold uppercase tracking-wide text-zinc-950"><Cloud className="h-3 w-3" /> {cloudUsesLegacyMask ? "Legacy estimate" : "ML estimate"}</span>
                    <span className="rounded-full border border-white/10 bg-black/60 px-3 py-1 text-[10px] text-white/90 backdrop-blur-md">{imageDatasetPhase === "bare_camera" ? "Pi Camera Module 3 Wide, no add-on lens" : cameraSetup}</span>
                  </div>

                  <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/15 to-transparent p-3">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                      <div>
                        <div className="text-[9px] font-mono uppercase tracking-widest text-white/55">Latest sky image · native 1280 x 960</div>
                        <div className="text-[10px] text-white/80">Latest image from Raspberry Pi camera.</div>
                        <div className="mt-1 text-[10px] text-zinc-300">{formatDateTime(latestImageTime)}</div>
                      </div>
                      <div className="rounded-[1.2rem] border border-white/10 bg-black/55 px-3 py-2.5 backdrop-blur-md">
                        <div className="text-[9px] uppercase tracking-widest text-zinc-400">{isExperimentalCloud ? "Cloud estimate" : "Cloud coverage"}</div>
                        {!usesMlCloudVector && isExperimentalCloud ? (
                          <>
                            <div className="text-[0.95rem] font-bold text-amber-300">{legacyCloudCoverageEnabled ? "Legacy only" : "Model pending"}</div>
                            <div className={`text-[11px] font-medium ${cloudDisplayStatus.tone}`}>{cloudDisplayStatus.label}</div>
                            <div className="mt-1 text-[9px] leading-4 text-amber-200">
                              {legacyCloudCoverageEnabled
                                ? `Legacy OpenCV estimate: ${cloudCoverage.toFixed(1)}%. Do not use as a measured cloud value.`
                                : "Legacy estimate disabled. Waiting for ML cloud estimate."}
                            </div>
                          </>
                        ) : (
                          <>
                            <div className="flex items-end gap-1"><span className="text-[1.2rem] font-bold text-amber-400">{cloudCoverage.toFixed(1)}</span><span className="pb-0.5 text-[10px] text-zinc-400">%</span></div>
                            <div className={`text-[11px] font-medium ${cloudDisplayStatus.tone}`}>{cloudDisplayStatus.label}</div>
                            {usesMlCloudVector ? (
                              <div className="mt-1 text-[9px] leading-4 text-sky-100">
                                ML estimate • regions {Number(cloudVector?.cloudRegionCount || 0)} • largest {Number(cloudVector?.largestCloudRegionPercent || 0).toFixed(1)}%
                              </div>
                            ) : null}
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </Card>

              <div className="col-span-12 flex min-h-0 flex-col gap-3 xl:col-span-2">
                <div className="flex items-center gap-2 px-1">
                  <Activity className="h-5 w-5 text-cyan-300" />
                  <div>
                    <CardTitle className="text-[1rem] font-semibold leading-5 text-[#f0e0d1]">Short-Term Forecast</CardTitle>
                    <p className="text-[10px] leading-4 text-zinc-500">{forecastSource === "stable-window" ? "5-minute averaged forecast from recent sensor history." : forecastSource === "random-forest" ? "Point forecast from sensor and image features." : forecastSource === "ridge" ? "Baseline point forecast." : "Fallback forecast."}</p>
                  </div>
                </div>
                <div className="flex flex-1 flex-col gap-3">
                  {forecastData.map((forecast, index) => {
                    const TrendIcon = forecast.trend === "up" ? ArrowUpRight : forecast.trend === "down" ? ArrowDownRight : Minus;
                    const accentText = index === 0 ? "text-cyan-300" : index === 1 ? "text-amber-300" : "text-slate-300";
                    const accentBorder = index === 0 ? "border-l-cyan-400" : index === 1 ? "border-l-amber-500" : "border-l-slate-500";
                    const statusText = forecastSource === "stable-window" ? "Stable Avg" : forecastSource === "random-forest" ? "RF + Image" : forecastSource === "ridge" ? "Baseline" : "Fallback";
                    return (
                      <Card key={forecast.time} className={`relative flex-1 rounded-[1rem] border border-white/10 border-l-[3px] ${accentBorder} bg-[#261e15]/40 p-3 shadow-[0_20px_50px_rgba(0,0,0,0.28)] backdrop-blur-xl`}>
                        <div className={`absolute right-3 top-2 text-[1.7rem] font-black opacity-10 ${accentText}`}>{forecast.time.replace(" ", "")}</div>
                        <div className="relative flex h-full flex-col justify-center">
                          <p className="text-[8px] font-bold uppercase tracking-[0.18em] text-zinc-500">{forecast.windowMinutes ? `Next ${forecast.windowMinutes} min avg` : forecast.time}</p>
                          <div className="mt-2 flex items-end justify-between gap-3">
                            <div>
                              <p className="text-[8px] font-bold uppercase tracking-[0.18em] text-zinc-400">Forecast Power</p>
                              <p className="text-[0.98rem] font-bold text-white">{Number(forecast.power).toFixed(1)} <span className="text-[9px] font-normal text-zinc-500">W</span></p>
                            </div>
                            <div className="text-right">
                              <p className="text-[8px] font-bold uppercase tracking-[0.18em] text-zinc-400">Confidence</p>
                              <p className={`text-[0.9rem] font-bold ${accentText}`}>{(forecast.confidence * 100).toFixed(1)}%</p>
                            </div>
                          </div>
                          <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-zinc-800">
                            <div className="h-full rounded-full bg-amber-500" style={{ width: `${Math.min(100, Math.max(4, (forecast.power / maxForecastPower) * 100))}%` }} />
                          </div>
                          <div className="mt-2.5 flex items-center justify-between border-t border-white/5 pt-2 text-[8px] font-bold uppercase tracking-[0.15em]">
                            <span className="text-zinc-500">{forecast.model || "Forecast model"}</span>
                            <span className={`inline-flex items-center gap-1 ${accentText}`}><TrendIcon className="h-3 w-3" />{statusText}</span>
                          </div>
                        </div>
                      </Card>
                    );
                  })}
                </div>
                <div className="rounded-[1rem] border border-white/10 bg-[#261e15]/40 p-3 text-[10px] text-zinc-300 shadow-[0_20px_50px_rgba(0,0,0,0.28)] backdrop-blur-xl">
                  <div className="text-[9px] font-bold uppercase tracking-[0.18em] text-zinc-500">Cloud Estimate Note</div>
                  <div className="mt-2 text-[11px] font-semibold text-sky-200">
                    {usesMlCloudVector
                      ? "Live cloud card is using ML cloud estimate"
                      : legacyCloudCoverageEnabled
                        ? "Historical rows may still contain legacy cloud values"
                        : "Legacy cloud estimate disabled at source"}
                  </div>
                  <p className="mt-2 text-[9px] leading-4 text-zinc-400">
                    {usesMlCloudVector
                      ? "This value is generated by the ML cloud model and should be treated as a model-based estimate, not final ground truth."
                      : "Live cloud coverage is not yet treated as a validated measured percentage."}
                  </p>
                  {forecastNote ? <p className="mt-3 rounded-2xl border border-violet-400/20 bg-violet-400/10 px-3 py-2 text-[10px] leading-4 text-violet-100">{forecastNote}</p> : null}
                  {forecastQuality?.electricalLowConfidence ? <p className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[10px] leading-4 text-amber-200">Current and power-factor readings are low-confidence during very low-power periods.</p> : null}
                  {forecastRangeGuardActive ? <p className="mt-3 rounded-2xl border border-amber-400/20 bg-amber-400/10 px-3 py-2 text-[10px] leading-4 text-amber-200">Forecast output was clipped to the recent measured power range.</p> : null}
                </div>
              </div>
            </section>
          </div>
        </div>
      </main>
    </div>
  );
}

