/**
 * Error codes the UI can act on.
 *
 * Every one of these has a different fix, and a user staring at "something went
 * wrong" cannot tell them apart. The overlay and the diagnostics page both map
 * a code to a sentence in Thai that says what to do next — which is the whole
 * reason the codes exist instead of raw messages.
 */
export type ErrCode =
  | 'NO_API_KEY'
  | 'INVALID_KEY'
  | 'QUOTA_EXCEEDED'
  | 'PROVIDER_REFUSED'
  | 'OFFLINE'
  | 'ACQUIRE_FAILED'
  | 'MODEL_LOAD_FAILED'
  | 'OFFSCREEN_FAILED'
  | 'VALIDATION_FAILED'
  | 'NO_TEXT_FOUND'
  | 'LOW_RESOLUTION'
  | 'CANCELLED'
  | 'UNKNOWN';

export class PipelineError extends Error {
  readonly code: ErrCode;
  /** A hint the user can actually follow, in Thai. */
  readonly hint: string;

  constructor(code: ErrCode, message: string, hint = '') {
    super(message);
    this.name = 'PipelineError';
    this.code = code;
    this.hint = hint || HINTS_TH[code];
  }
}

export const HINTS_TH: Record<ErrCode, string> = {
  NO_API_KEY: 'ยังไม่ได้ใส่ Gemini API key — เปิดหน้าตั้งค่าแล้ววาง key',
  INVALID_KEY: 'API key ใช้ไม่ได้ — ตรวจว่าคัดลอกครบและเปิดใช้ Generative Language API แล้ว',
  QUOTA_EXCEEDED: 'โควตา Gemini เต็ม (ฟรี 15 ครั้ง/นาที · 1,000 ครั้ง/วัน) — รอสักครู่แล้วลองใหม่',
  PROVIDER_REFUSED: 'Gemini ปฏิเสธหน้านี้ — ลองกดแปลใหม่ ระบบจะแยกส่งทีละกล่อง',
  OFFLINE: 'ต่อเน็ตไม่ได้ — ตรวจการเชื่อมต่อแล้วลองใหม่',
  ACQUIRE_FAILED: 'ดึงไฟล์รูปไม่สำเร็จ — เว็บอาจบล็อกหรือรูปยังโหลดไม่เสร็จ ลองรีเฟรชหน้า',
  MODEL_LOAD_FAILED: 'โหลดโมเดลตรวจจับข้อความไม่สำเร็จ — เช็คอินเทอร์เน็ตแล้วกด "ตรวจสอบระบบ" ในหน้าตั้งค่า',
  OFFSCREEN_FAILED: 'เปิดตัวประมวลผลเบื้องหลังไม่ได้ — ลองปิดเปิด extension ที่ chrome://extensions',
  VALIDATION_FAILED: 'ผลลัพธ์จากตัวแปลผิดรูปแบบ — กดแปลใหม่อีกครั้ง',
  NO_TEXT_FOUND: 'ไม่พบข้อความในภาพนี้',
  LOW_RESOLUTION: 'ภาพเล็กเกินไปจนอ่านตัวหนังสือไม่ออก — ซูมหน้าเว็บขึ้นแล้วลองใหม่',
  CANCELLED: 'ยกเลิกแล้ว',
  UNKNOWN: 'เกิดข้อผิดพลาดที่ไม่รู้จัก — ดู console ของหน้าเว็บหรือกด "ตรวจสอบระบบ"',
};

/** Narrow anything thrown into a code + message pair that can cross a message port. */
export function toErrorPayload(err: unknown): { code: ErrCode; message: string; hint: string } {
  if (err instanceof PipelineError) {
    return { code: err.code, message: err.message, hint: err.hint };
  }
  const message = err instanceof Error ? err.message : String(err);
  // A failed fetch with no response is indistinguishable from being offline at
  // this layer, and "check your connection" is the more useful guess.
  const code: ErrCode = /failed to fetch|networkerror/i.test(message) ? 'OFFLINE' : 'UNKNOWN';
  return { code, message, hint: HINTS_TH[code] };
}
