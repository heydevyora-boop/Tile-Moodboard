import { Request, Response } from 'express';
import { catchAsync } from '@utils/catchAsync';
import { config } from '@config/index';
import { geminiClient } from '@services/gemini.service';
import { googleDriveClient } from '@services/googleDrive.service';
import { checkPythonAIHealth } from '@services/python-ai.service';

export const getGeminiStatus = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      configured: await geminiClient.isConfigured(),
      model: config.gemini.model,
      timeoutMs: config.gemini.timeoutMs,
      maxRetries: config.gemini.maxRetries,
      retryBaseDelayMs: config.gemini.retryBaseDelayMs,
      temperature: config.gemini.temperature,
      maxOutputTokens: config.gemini.maxOutputTokens,
    },
  });
});

export const testGeminiConnection = catchAsync(async (_req: Request, res: Response) => {
  const result = await geminiClient.testConnection();
  // Always 200: the test itself succeeded in running, regardless of what
  // it found. Encoding "Gemini is unreachable" as an HTTP error status
  // would make the frontend's generic error handling swallow the actual
  // result.message — this way `data.ok` carries that meaning instead.
  res.status(200).json({ success: true, data: result });
});

export const getDriveStatus = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      configured: googleDriveClient.isConfigured(),
      rootFolder: config.google.driveRootFolder,
    },
  });
});

export const testDriveConnection = catchAsync(async (_req: Request, res: Response) => {
  const result = await googleDriveClient.testConnection();
  res.status(200).json({ success: true, data: result });
});

export const getPythonAiStatus = catchAsync(async (_req: Request, res: Response) => {
  res.status(200).json({
    success: true,
    data: {
      baseUrl: config.python.aiBaseUrl,
    },
  });
});

export const testPythonAiConnection = catchAsync(async (_req: Request, res: Response) => {
  // Same "always 200" reasoning as testGeminiConnection/testDriveConnection —
  // an unreachable service is a real, expected result the frontend needs to
  // read from data.ok, not an HTTP error that gets swallowed by generic
  // error handling.
  const startedAt = Date.now();
  try {
    const health = await checkPythonAIHealth();
    res.status(200).json({ success: true, data: { ok: true, latencyMs: Date.now() - startedAt, health } });
  } catch (err) {
    res.status(200).json({
      success: true,
      data: {
        ok: false,
        message: err instanceof Error ? err.message : 'Could not reach the Python AI service.',
      },
    });
  }
});
