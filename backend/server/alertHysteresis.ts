/**
 * Alert Hysteresis Logic
 * Prevents alert spam by requiring conditions to persist for a duration
 * and enforcing cooldown periods between repeated alerts
 */

import { getDb } from "./db";
import { alertHistory, alertConfigs } from "../drizzle/schema";
import { eq } from "drizzle-orm";

export interface AlertState {
  alertType: "power" | "cloud" | "temperature" | "humidity";
  currentValue: number;
  thresholdValue: number;
  isTriggered: boolean;
  duration: number; // seconds
}

export interface HysteresisConfig {
  hysteresisDurationSeconds: number;
  alertCooldownSeconds: number;
}

/**
 * Check if an alert should be triggered based on hysteresis logic
 */
export async function shouldTriggerAlert(
  alertType: "power" | "cloud" | "temperature" | "humidity",
  currentValue: number,
  thresholdValue: number,
  isExceeded: boolean,
  duration: number = 0
): Promise<boolean> {
  // Get alert config
  const db = await getDb();
  if (!db) return false;

  const config = await (db as any).query?.alertConfigs?.findFirst?.();
  if (!config) return false;

  const hysteresisDuration = config.hysteresisDurationSeconds || 30;
  const cooldownDuration = config.alertCooldownSeconds || 300;

  // Check if condition has persisted for required duration
  if (duration < hysteresisDuration) {
    return false;
  }

  // Check cooldown - don't trigger if same alert was triggered recently
  const lastAlert = await (db as any).query?.alertHistory?.findFirst?.({
    where: (table: any) => eq(table.alertType, alertType),
    orderBy: (table: any) => [table.triggeredAt],
  });

  if (lastAlert) {
    const timeSinceLastAlert = (Date.now() - lastAlert.triggeredAt.getTime()) / 1000;
    if (timeSinceLastAlert < cooldownDuration) {
      return false;
    }
  }

  return isExceeded;
}

/**
 * Track alert state over time to implement hysteresis
 */
export class AlertStateTracker {
  private states: Map<string, { startTime: number; value: number }> = new Map();

  /**
   * Update alert state and check if it should trigger
   */
  updateState(
    alertType: string,
    currentValue: number,
    isExceeded: boolean,
    hysteresisDuration: number = 30
  ): boolean {
    const key = `${alertType}`;
    const now = Date.now();

    if (isExceeded) {
      // Condition is exceeded
      const state = this.states.get(key);

      if (!state) {
        // Start tracking
        this.states.set(key, { startTime: now, value: currentValue });
        return false; // Not yet at duration
      }

      // Check if duration threshold reached
      const duration = (now - state.startTime) / 1000;
      if (duration >= hysteresisDuration) {
        return true; // Trigger alert
      }

      return false; // Still waiting for duration
    } else {
      // Condition is not exceeded - reset state
      this.states.delete(key);
      return false;
    }
  }

  /**
   * Get current duration for a state
   */
  getDuration(alertType: string): number {
    const key = `${alertType}`;
    const state = this.states.get(key);

    if (!state) {
      return 0;
    }

    return (Date.now() - state.startTime) / 1000;
  }

  /**
   * Reset state for an alert type
   */
  resetState(alertType: string): void {
    this.states.delete(`${alertType}`);
  }

  /**
   * Get all active states
   */
  getActiveStates(): Map<string, { startTime: number; value: number }> {
    return new Map(this.states);
  }
}

/**
 * Create an alert with hysteresis check
 */
export async function createAlertWithHysteresis(
  alertType: "power" | "cloud" | "temperature" | "humidity",
  severity: "info" | "warning" | "critical",
  message: string,
  currentValue: number,
  thresholdValue: number,
  duration: number = 0
): Promise<boolean> {
  // Check if alert should be triggered
  const shouldTrigger = await shouldTriggerAlert(
    alertType,
    currentValue,
    thresholdValue,
    true,
    duration
  );

  if (!shouldTrigger) {
    return false;
  }

  // Create alert record
  try {
    const db = await getDb();
    if (!db) return false;

    await db.insert(alertHistory).values({
      alertType,
      severity,
      message,
      currentValue: currentValue.toString(),
      thresholdValue: thresholdValue.toString(),
      isAcknowledged: 0,
      triggeredAt: new Date(),
    });

    return true;
  } catch (error) {
    console.error("Error creating alert:", error);
    return false;
  }
}

/**
 * Get alert statistics
 */
export async function getAlertStatistics(): Promise<{
  totalAlerts: number;
  acknowledgedAlerts: number;
  unacknowledgedAlerts: number;
  alertsByType: Record<string, number>;
  lastAlertTime: Date | null;
}> {
  const db = await getDb();
  if (!db) {
    return {
      totalAlerts: 0,
      acknowledgedAlerts: 0,
      unacknowledgedAlerts: 0,
      alertsByType: { power: 0, cloud: 0, temperature: 0, humidity: 0 },
      lastAlertTime: null,
    };
  }

  const allAlerts = await (db as any).query?.alertHistory?.findMany?.();

  const stats = {
    totalAlerts: allAlerts?.length || 0,
    acknowledgedAlerts: allAlerts?.filter((a: any) => a.isAcknowledged).length || 0,
    unacknowledgedAlerts: allAlerts?.filter((a: any) => !a.isAcknowledged).length || 0,
    alertsByType: {
      power: 0,
      cloud: 0,
      temperature: 0,
      humidity: 0,
    },
    lastAlertTime: allAlerts?.length > 0 ? allAlerts[0].triggeredAt : null,
  };

  // Count by type
  allAlerts?.forEach((alert: any) => {
    if (alert.alertType in stats.alertsByType) {
      stats.alertsByType[alert.alertType as keyof typeof stats.alertsByType]++;
    }
  });

  return stats;
}

/**
 * Acknowledge an alert
 */
export async function acknowledgeAlert(alertId: number): Promise<boolean> {
  try {
    const db = await getDb();
    if (!db) return false;

    await db
      .update(alertHistory)
      .set({ isAcknowledged: 1 })
      .where(eq(alertHistory.id, alertId));

    return true;
  } catch (error) {
    console.error("Error acknowledging alert:", error);
    return false;
  }
}

/**
 * Get unacknowledged alerts
 */
export async function getUnacknowledgedAlerts() {
  const db = await getDb();
  if (!db) return [];

  return await (db as any).query?.alertHistory?.findMany?.({
    where: (table: any) => eq(table.isAcknowledged, 0),
    orderBy: (table: any) => [table.triggeredAt],
  });
}
