import { db } from "@/db";
import { auditLogs } from "@/db/schema";

export class AuditLogger {
  public static async log(
    action: string,
    details?: Record<string, unknown>,
    ip?: string,
    status: "success" | "warning" | "error" = "success",
    userId?: string
  ): Promise<void> {
    try {
      await db.insert(auditLogs).values({
        id: `aud_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        userId: userId ?? null,
        action,
        details: details || {},
        ip: ip || "127.0.0.1",
        status,
      });
    } catch (err) {
      console.warn("Failed to write audit log:", err);
    }
  }
}
