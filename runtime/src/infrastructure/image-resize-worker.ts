import { parentPort } from "node:worker_threads";
import { ProviderError } from "../domain/errors.js";
import {
  IMAGE_WORKER_RESPONSE_TYPE,
  processImage,
  type ImageWorkerResponse,
  type SerializedImageWorkerError,
  type SerializedImageWorkerResult,
} from "./images.js";

export {
  IMAGE_WORKER_RESPONSE_TYPE,
  type ImageWorkerResponse,
  type SerializedImageWorkerError,
  type SerializedImageWorkerResult,
};

parentPort?.on("message", (payload: { filePath?: unknown }) => {
  try {
    const filePath = String(payload?.filePath ?? "");
    const processed = processImage(filePath);
    const bytes = new Uint8Array(processed.data);
    const message: SerializedImageWorkerResult = {
      type: IMAGE_WORKER_RESPONSE_TYPE,
      ok: true,
      data: bytes,
      mime: processed.mime,
      width: processed.width,
      height: processed.height,
      hint: processed.hint,
    };
    parentPort?.postMessage(message, [bytes.buffer]);
  } catch (err) {
    if (err instanceof ProviderError) {
      const message: SerializedImageWorkerError = {
        type: IMAGE_WORKER_RESPONSE_TYPE,
        ok: false,
        message: err.message,
        code: err.code,
        status: err.status,
        errorType: err.error_type,
      };
      parentPort?.postMessage(message);
      return;
    }
    const generic = err instanceof Error ? err : new Error(String(err));
    const message: SerializedImageWorkerError = {
      type: IMAGE_WORKER_RESPONSE_TYPE,
      ok: false,
      message: generic.message,
      code: null,
      status: "failed",
      errorType: generic.name || "Error",
    };
    parentPort?.postMessage(message);
  }
});
