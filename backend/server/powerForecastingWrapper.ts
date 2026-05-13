/**
 * TypeScript wrapper for Power Forecasting Python module
 * Provides type-safe interface to power forecasting functionality
 */

export interface SensorReading {
  powerWatts: string | number;
  temperatureCelsius?: string | number;
  humidityPercent?: string | number;
  windSpeedMs?: string | number;
  [key: string]: any;
}

export interface ForecastFactor {
  power_trend: number;
  cloud_impact: number;
  temperature_efficiency: number;
  time_pattern: number;
  combined_factor: number;
}

export interface PowerForecastResult {
  forecast_power: number;      // Predicted power in watts
  confidence: number;          // 0-1 confidence level
  forecast_time_minutes: number;
  factors?: ForecastFactor;
  error?: string;
}

export class PowerForecaster {
  private forecastHorizon = 15; // minutes
  private minDataPoints = 10;

  /**
   * Forecast power output for next 15 minutes
   */
  forecastPower(
    recentReadings: SensorReading[],
    currentCloudCoverage: number,
    currentTemperature: number
  ): PowerForecastResult {
    try {
      if (recentReadings.length < this.minDataPoints) {
        return {
          forecast_power: 0,
          confidence: 0,
          forecast_time_minutes: this.forecastHorizon,
          error: "Insufficient historical data",
        };
      }

      // Extract power values
      const powers = recentReadings.map((r) => {
        const power = typeof r.powerWatts === "string" 
          ? parseFloat(r.powerWatts) 
          : r.powerWatts;
        return isNaN(power) ? 0 : power;
      });

      // Calculate power trend
      const powerTrend = this.calculatePowerTrend(powers);

      // Calculate cloud impact
      const cloudImpact = this.calculateCloudImpact(currentCloudCoverage);

      // Calculate temperature efficiency
      const tempEfficiency = this.calculateTemperatureEfficiency(currentTemperature);

      // Calculate time pattern
      const timePattern = this.calculateTimePattern();

      // Combine factors
      const weights = {
        power_trend: 0.4,
        cloud_impact: 0.3,
        temperature: 0.15,
        time_pattern: 0.15,
      };

      const combinedFactor =
        weights.power_trend * (1.0 + powerTrend * 0.1) +
        weights.cloud_impact * cloudImpact +
        weights.temperature * tempEfficiency +
        weights.time_pattern * timePattern;

      // Get current power
      const currentPower = powers[powers.length - 1] || 0;

      // Forecast power
      let forecastPower = currentPower * combinedFactor;
      forecastPower = Math.max(0, forecastPower);

      // Calculate confidence
      const variance = this.calculateVariance(powers.slice(-10));
      const maxPower = Math.max(...powers);
      const confidence = Math.min(
        0.95,
        Math.max(0.5, 1.0 - (variance / (maxPower * maxPower + 1)) * 0.3)
      );

      return {
        forecast_power: Math.round(forecastPower * 100) / 100,
        confidence: Math.round(confidence * 100) / 100,
        forecast_time_minutes: this.forecastHorizon,
        factors: {
          power_trend: Math.round(powerTrend * 1000) / 1000,
          cloud_impact: Math.round(cloudImpact * 1000) / 1000,
          temperature_efficiency: Math.round(tempEfficiency * 1000) / 1000,
          time_pattern: Math.round(timePattern * 1000) / 1000,
          combined_factor: Math.round(combinedFactor * 1000) / 1000,
        },
      };
    } catch (error) {
      return {
        forecast_power: 0,
        confidence: 0,
        forecast_time_minutes: this.forecastHorizon,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  private calculatePowerTrend(powers: number[]): number {
    if (powers.length < 2) return 0;

    const x = Array.from({ length: powers.length }, (_, i) => i);
    const y = powers;

    // Simple linear regression
    const n = x.length;
    const sumX = x.reduce((a, b) => a + b, 0);
    const sumY = y.reduce((a, b) => a + b, 0);
    const sumXY = x.reduce((sum, xi, i) => sum + xi * y[i], 0);
    const sumX2 = x.reduce((sum, xi) => sum + xi * xi, 0);

    const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);

    const maxChange = Math.max(...y) * 0.5 || 100;
    const trend = Math.max(-1, Math.min(1, slope / maxChange));

    return trend;
  }

  private calculateCloudImpact(cloudCoverage: number): number {
    // More clouds = less power
    const cloudFactor = 1.0 - (cloudCoverage / 100.0) * 0.8;
    return Math.max(0, Math.min(1, cloudFactor));
  }

  private calculateTemperatureEfficiency(temperature: number): number {
    const optimalTemp = 25;
    const tempDiff = temperature - optimalTemp;
    let efficiency = 1.0 - tempDiff * 0.005;

    // Clamp to 0.7-1.0
    efficiency = Math.max(0.7, Math.min(1.0, efficiency));

    return efficiency;
  }

  private calculateTimePattern(): number {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();

    // Solar power available 6am-6pm
    if (hour < 6 || hour >= 18) {
      return 0;
    }

    // Peak at noon
    const timeMinutes = hour * 60 + minute;
    const peakMinutes = 12 * 60;
    const diff = Math.abs(timeMinutes - peakMinutes);

    // Gaussian-like distribution
    const timePattern = Math.exp(-((diff * diff) / (6 * 60) ** 2));

    return timePattern;
  }

  private calculateVariance(values: number[]): number {
    if (values.length === 0) return 0;

    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    const variance = values.reduce((sum, val) => sum + (val - mean) ** 2, 0) / values.length;

    return variance;
  }
}
