import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * TypeScript wrapper for Cloud Detection Python module
 * Provides type-safe interface to cloud detection functionality
 */

export interface CloudDetectionResult {
  cloud_coverage: number;      // 0-100 percentage
  sky_coverage: number;        // 0-100 percentage
  image_quality: number;       // 0-1 score
  cloud_pixels?: number;
  total_pixels?: number;
  building_coverage?: number;
  cloud_region_count?: number;
  largest_cloud_region_percent?: number;
  analysis?: string;
  cloud_vector_data?: string;
  error?: string;
}

export class CloudDetector {
  private projectRoot = path.resolve(import.meta.dirname, "..");
  private pythonExe = path.join(this.projectRoot, ".venv-fastapi", "Scripts", "python.exe");
  private cliPath = path.join(this.projectRoot, "scripts", "infer_cloud_vector_cli.py");

  private parseResult(stdout: string): CloudDetectionResult {
    const payload = JSON.parse(stdout) as Record<string, unknown>;
    const cloudCoverage = Number(payload.cloudCoveragePercent ?? 0);
    const skyCoverage = Number(payload.skyCoveragePercent ?? 0);
    const buildingCoverage = Number(payload.buildingCoveragePercent ?? 0);
    const cloudRegionCount = Number(payload.cloudRegionCount ?? 0);
    const largestCloudRegionPercent = Number(payload.largestCloudRegionPercent ?? 0);

    return {
      cloud_coverage: Number(cloudCoverage.toFixed(2)),
      sky_coverage: Number(skyCoverage.toFixed(2)),
      building_coverage: Number(buildingCoverage.toFixed(2)),
      image_quality: payload.cloudCoverageConfidence === "calibrated" ? 1 : 0.85,
      cloud_pixels: Number(payload.cloudPixels ?? 0),
      total_pixels: Number(payload.skyRegionPixels ?? 0) + Number(payload.buildingPixels ?? 0),
      cloud_region_count: cloudRegionCount,
      largest_cloud_region_percent: Number(largestCloudRegionPercent.toFixed(2)),
      analysis: String(payload.analysis ?? "fixed-building-mask-patch-rf"),
      cloud_vector_data: JSON.stringify(payload),
    };
  }

  private inferFromBase64(base64Image: string, imageName: string): CloudDetectionResult {
    const result = spawnSync(
      this.pythonExe,
      [this.cliPath, "--stdin-base64", "--image-name", imageName],
      {
        cwd: this.projectRoot,
        encoding: "utf-8",
        input: base64Image,
        maxBuffer: 12 * 1024 * 1024,
        windowsHide: true,
      }
    );

    if (result.status !== 0) {
      const stderr = (result.stderr || result.stdout || "").trim();
      throw new Error(stderr || "Cloud inference CLI failed");
    }

    return this.parseResult(result.stdout);
  }

  /**
   * Detect clouds from image bytes using the Python ML pipeline.
   */
  detectCloudsFromBytes(imageBuffer: Buffer): CloudDetectionResult {
    try {
      return this.inferFromBase64(imageBuffer.toString("base64"), "node-bytes.jpg");
    } catch (error) {
      return {
        cloud_coverage: 0,
        sky_coverage: 0,
        image_quality: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Detect clouds from file path
   */
  detectCloudsFromFile(filePath: string): CloudDetectionResult {
    try {
      const buffer = readFileSync(filePath);
      return this.inferFromBase64(buffer.toString("base64"), path.basename(filePath));
    } catch (error) {
      return {
        cloud_coverage: 0,
        sky_coverage: 0,
        image_quality: 0,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }
}
