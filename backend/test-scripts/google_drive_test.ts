import 'tsconfig-paths/register';
import { GoogleDriveClient, DriveApiClient } from '../src/services/googleDrive.service';

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra?: unknown) {
  if (cond) {
    console.log(`OK   ${label}`);
    pass++;
  } else {
    console.log(`FAIL ${label}`, extra !== undefined ? JSON.stringify(extra) : '');
    fail++;
  }
}

function driveError(status: number, reason?: string, message = 'error') {
  return { response: { status, data: { error: { message, errors: reason ? [{ reason }] : undefined } } } };
}

function makeFakeDrive(overrides: Partial<DriveApiClient> = {}): DriveApiClient {
  return {
    files: {
      create: (async () => ({ data: { id: 'file-1', name: 'test.pdf', webViewLink: 'https://drive.google.com/file/d/file-1/view' } })) as unknown as DriveApiClient['files']['create'],
      delete: (async () => ({ data: {} })) as unknown as DriveApiClient['files']['delete'],
      list: (async () => ({ data: { files: [] } })) as unknown as DriveApiClient['files']['list'],
      get: (async () => ({ data: { webViewLink: 'https://drive.google.com/file/d/file-1/view' } })) as unknown as DriveApiClient['files']['get'],
      ...overrides.files,
    },
    permissions: {
      create: (async () => ({ data: {} })) as unknown as DriveApiClient['permissions']['create'],
      ...overrides.permissions,
    },
  };
}

async function main() {
  {
    const configured = new GoogleDriveClient(makeFakeDrive());
    check('1. isConfigured() is true when a Drive client override is provided', configured.isConfigured());
  }

  {
    let capturedArgs: unknown = null;
    const drive = makeFakeDrive({
      files: {
        create: (async (args: unknown) => {
          capturedArgs = args;
          return { data: { id: 'uploaded-1', name: 'board.pdf', webViewLink: 'https://drive.google.com/file/d/uploaded-1/view' } };
        }) as unknown as DriveApiClient['files']['create'],
      } as DriveApiClient['files'],
    });
    const client = new GoogleDriveClient(drive);
    const result = await client.uploadFile({ name: 'board.pdf', mimeType: 'application/pdf', content: Buffer.from('fake pdf bytes'), parentFolderId: 'folder-123' });

    check('2a. uploadFile() returns the id/name/webViewLink from the API', result.id === 'uploaded-1' && result.name === 'board.pdf' && !!result.webViewLink, result);
    const args = capturedArgs as { requestBody?: { name?: string; parents?: string[] }; media?: { mimeType?: string } };
    check('2b. Upload request includes the correct filename', args.requestBody?.name === 'board.pdf', args);
    check('2c. Upload request includes the correct parent folder', args.requestBody?.parents?.[0] === 'folder-123', args);
    check('2d. Upload request includes the correct mimeType', args.media?.mimeType === 'application/pdf', args);
  }

  {
    let capturedFileId: string | null = null;
    const drive = makeFakeDrive({
      files: {
        delete: (async (args: { fileId?: string }) => {
          capturedFileId = args.fileId ?? null;
          return { data: {} };
        }) as unknown as DriveApiClient['files']['delete'],
      } as DriveApiClient['files'],
    });
    const client = new GoogleDriveClient(drive);
    await client.deleteFile('file-to-delete');
    check('3. deleteFile() calls the API with the correct fileId', capturedFileId === 'file-to-delete', capturedFileId);
  }

  {
    let capturedQuery: string | null = null;
    const drive = makeFakeDrive({
      files: {
        list: (async (args: { q?: string }) => {
          capturedQuery = args.q ?? null;
          return { data: { files: [{ id: 'folder-existing', name: 'CasaDeAurum' }] } };
        }) as unknown as DriveApiClient['files']['list'],
      } as DriveApiClient['files'],
    });
    const client = new GoogleDriveClient(drive);
    const found = await client.findFolder('CasaDeAurum');
    check('4a. findFolder() returns the existing folder', found?.id === 'folder-existing', found);
    const query: string = capturedQuery ?? '';
    check('4b. findFolder() queries for the folder mimeType and exact name', query.includes("mimeType='application/vnd.google-apps.folder'") && query.includes("name='CasaDeAurum'"), query);
  }
  {
    const drive = makeFakeDrive({ files: { list: (async () => ({ data: { files: [] } })) as unknown as DriveApiClient['files']['list'] } as DriveApiClient['files'] });
    const client = new GoogleDriveClient(drive);
    const found = await client.findFolder('DoesNotExist');
    check('5. findFolder() returns null when nothing matches', found === null, found);
  }

  {
    let createCalls = 0;
    const drive = makeFakeDrive({
      files: {
        list: (async () => ({ data: { files: [{ id: 'existing-folder', name: 'Print Board Exports' }] } })) as unknown as DriveApiClient['files']['list'],
        create: (async () => { createCalls++; return { data: { id: 'should-not-be-created', name: 'x' } }; }) as unknown as DriveApiClient['files']['create'],
      } as DriveApiClient['files'],
    });
    const client = new GoogleDriveClient(drive);
    const result = await client.getOrCreateFolder('Print Board Exports');
    check('6a. getOrCreateFolder() returns the existing folder', result.id === 'existing-folder', result);
    check('6b. getOrCreateFolder() does NOT call create when a folder already exists (real folder management, not blind duplication)', createCalls === 0, createCalls);
  }
  {
    let createCalls = 0;
    const drive = makeFakeDrive({
      files: {
        list: (async () => ({ data: { files: [] } })) as unknown as DriveApiClient['files']['list'],
        create: (async () => { createCalls++; return { data: { id: 'newly-created', name: 'New Folder' } }; }) as unknown as DriveApiClient['files']['create'],
      } as DriveApiClient['files'],
    });
    const client = new GoogleDriveClient(drive);
    const result = await client.getOrCreateFolder('New Folder');
    check('7a. getOrCreateFolder() creates when nothing exists', result.id === 'newly-created', result);
    check('7b. create() was called exactly once', createCalls === 1, createCalls);
  }

  {
    let permissionArgs: unknown = null;
    const drive = makeFakeDrive({
      permissions: {
        create: (async (args: unknown) => { permissionArgs = args; return { data: {} }; }) as unknown as DriveApiClient['permissions']['create'],
      },
      files: {
        get: (async () => ({ data: { webViewLink: 'https://drive.google.com/file/d/shared-file/view' } })) as unknown as DriveApiClient['files']['get'],
      } as DriveApiClient['files'],
    });
    const client = new GoogleDriveClient(drive);
    const link = await client.generatePublicLink('shared-file');
    check('8a. generatePublicLink() returns the webViewLink', link === 'https://drive.google.com/file/d/shared-file/view', link);
    const permArgs = permissionArgs as { fileId?: string; requestBody?: { role?: string; type?: string } };
    check('8b. Permission is set to role=reader, type=anyone (public view link, not edit)', permArgs.requestBody?.role === 'reader' && permArgs.requestBody?.type === 'anyone', permArgs);
  }

  {
    let calls = 0;
    const drive = makeFakeDrive({
      files: {
        list: (async () => {
          calls++;
          if (calls < 3) throw driveError(429, 'rateLimitExceeded');
          return { data: { files: [{ id: 'found-after-retry', name: 'x' }] } };
        }) as unknown as DriveApiClient['files']['list'],
      } as DriveApiClient['files'],
    });
    const client = new GoogleDriveClient(drive);
    const result = await client.findFolder('x');
    check('9a. Rate-limit error recovers after retries', result?.id === 'found-after-retry', result);
    check('9b. Took exactly 3 attempts', calls === 3, calls);
  }

  {
    let calls = 0;
    const drive = makeFakeDrive({
      files: {
        delete: (async () => {
          calls++;
          throw driveError(404, undefined, 'File not found');
        }) as unknown as DriveApiClient['files']['delete'],
      } as DriveApiClient['files'],
    });
    const client = new GoogleDriveClient(drive);
    let threw: unknown = null;
    try {
      await client.deleteFile('nonexistent');
    } catch (err) {
      threw = err;
    }
    check('10a. 404 throws an error', threw instanceof Error);
    check('10b. Only ONE attempt made for a 404 — not retried', calls === 1, calls);
  }
  {
    let calls = 0;
    const drive = makeFakeDrive({
      files: {
        create: (async () => {
          calls++;
          throw driveError(403, undefined, 'Insufficient permissions');
        }) as unknown as DriveApiClient['files']['create'],
      } as DriveApiClient['files'],
    });
    const client = new GoogleDriveClient(drive);
    let threw: unknown = null;
    try {
      await client.createFolder('x');
    } catch (err) {
      threw = err;
    }
    check('11. A genuine 403 (permissions, not rate limit) is not retried', calls === 1, calls);
    void threw;
  }

  {
    const okDrive = makeFakeDrive({ files: { list: (async () => ({ data: { files: [{ id: 'root-folder', name: 'CasaDeAurum' }] } })) as unknown as DriveApiClient['files']['list'] } as DriveApiClient['files'] });
    const okClient = new GoogleDriveClient(okDrive);
    const okResult = await okClient.testConnection();
    check('12a. testConnection() reports ok:true when the folder lookup succeeds', okResult.ok === true && typeof okResult.latencyMs === 'number', okResult);

    const failDrive = makeFakeDrive({
      files: {
        list: (async () => { throw driveError(401, undefined, 'Invalid credentials'); }) as unknown as DriveApiClient['files']['list'],
        create: (async () => { throw driveError(401, undefined, 'Invalid credentials'); }) as unknown as DriveApiClient['files']['create'],
      } as DriveApiClient['files'],
    });
    const failClient = new GoogleDriveClient(failDrive);
    const failResult = await failClient.testConnection();
    check('12b. testConnection() reports ok:false with a message on failure', failResult.ok === false && !!failResult.message, failResult);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
