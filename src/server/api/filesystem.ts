/**
 * Filesystem browser & search API — supports directory browsing and file search
 * for the DirectoryPicker component and @-triggered file search popup.
 */

//@C:ID=M.FB.filesystemBrowser;K=M;V=1.0;P=Import dependencies;D=API;M=Filesystem;S=Browser
import * as path from 'path'
import * as fs from 'fs'
import * as os from 'os'

//@C:ID=D.FB.MimeTypes;K=D;V=1.0;P=Define image MIME type mappings;D=API;M=Filesystem;S=FileServing
const IMAGE_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
}

//@C:ID=E.FB.handleFilesystemRoute;K=E;V=1.0;P=Route filesystem API requests;D=API;M=Filesystem;S=Router;Provider=FilesystemAPI;Consumer=Frontend;In=string,URL;Out=Promise<Response>
export async function handleFilesystemRoute(pathname: string, url: URL): Promise<Response> {
  console.log("E.FB.handleFilesystemRoute");
  
  ///@C:FB.RouteRequests
  if (pathname === '/api/filesystem/browse') {
    return handleBrowse(url)
  }

  if (pathname === '/api/filesystem/file') {
    return handleServeFile(url)
  }

  return new Response(JSON.stringify({ error: 'Not found' }), { status: 404 })
}

//@C:ID=F.FB.handleServeFile;K=F;V=1.0;P=Serve file contents with security checks;D=API;M=Filesystem;S=FileServing;In=URL;Out=Promise<Response>
async function handleServeFile(url: URL): Promise<Response> {
  console.log("F.FB.handleServeFile");
  
  ///@C:FB.ValidateFilePath
  const filePath = url.searchParams.get('path')
  if (!filePath) {
    return json({ error: 'Missing path parameter' }, 400)
  }

  const resolvedPath = path.resolve(filePath)

  ///@C:FB.SecurityCheck
  // Path whitelist: only allow access under home directory or /tmp
  const homeDir = os.homedir()
  if (!resolvedPath.startsWith(homeDir) && !resolvedPath.startsWith('/tmp')) {
    return json({ error: 'Access denied: path outside allowed directory' }, 403)
  }

  ///@C:FB.CheckMimeType
  const ext = path.extname(resolvedPath).toLowerCase()
  const mimeType = IMAGE_MIME_TYPES[ext]

  if (!mimeType) {
    return json({ error: 'Unsupported file type' }, 400)
  }

  ///@C:FB.ReadAndServeFile
  try {
    const stat = fs.statSync(resolvedPath)
    if (!stat.isFile()) {
      return json({ error: 'Not a file' }, 400)
    }
    // Limit to 50MB
    if (stat.size > 50 * 1024 * 1024) {
      return json({ error: 'File too large' }, 400)
    }

    const data = fs.readFileSync(resolvedPath)
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': mimeType,
        'Content-Length': String(stat.size),
        'Cache-Control': 'private, max-age=3600',
      },
    })
  } catch {
    return json({ error: 'File not found' }, 404)
  }
}

//@C:ID=F.FB.handleBrowse;K=F;V=1.0;P=Browse directory contents with optional search;D=API;M=Filesystem;S=DirectoryBrowsing;In=URL;Out=Promise<Response>
async function handleBrowse(url: URL): Promise<Response> {
  console.log("F.FB.handleBrowse");
  
  ///@C:FB.ResolvePath
  const targetPath = url.searchParams.get('path') || process.env.HOME || '/'
  const resolvedPath = path.resolve(targetPath)

  ///@C:FB.ValidatePathAccess
  // Path whitelist: only allow browsing under home directory or /tmp
  const homeDir = os.homedir()
  if (!resolvedPath.startsWith(homeDir) && !resolvedPath.startsWith('/tmp')) {
    return json({ error: 'Access denied: path outside allowed directory' }, 403)
  }

  ///@C:FB.ParseParameters
  const searchQuery = url.searchParams.get('search') || ''
  const includeFiles = url.searchParams.get('includeFiles') === 'true'
  const maxResults = Math.min(parseInt(url.searchParams.get('maxResults') || '200', 10), 200)

  try {
    ///@C:FB.ValidateDirectory
    const stat = fs.statSync(resolvedPath)
    if (!stat.isDirectory()) {
      return json({ error: 'Not a directory', path: resolvedPath }, 400)
    }

    const entries = fs.readdirSync(resolvedPath, { withFileTypes: true })

    ///@C:FB.SearchMode
    if (searchQuery) {
      // Search mode: filter by filename, include both dirs and files
      const query = searchQuery.toLowerCase()
      const results = entries
        .filter((e) => {
          if (e.name.startsWith('.')) return false
          if (e.isDirectory()) return e.name.toLowerCase().includes(query)
          if (!includeFiles) return false
          return e.name.toLowerCase().includes(query)
        })
        .slice(0, maxResults)
        .map((e) => ({
          name: e.name,
          path: path.join(resolvedPath, e.name),
          isDirectory: e.isDirectory(),
        }))
        .sort((a, b) => {
          // Directories first, then alphabetically
          if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
          return a.name.localeCompare(b.name)
        })

      return json({
        currentPath: resolvedPath,
        parentPath: path.dirname(resolvedPath),
        entries: results,
        query: searchQuery,
      })
    }

    ///@C:FB.BrowseMode
    // Browse mode: show all directories (and optionally files)
    const filtered = entries.filter((e) => {
      if (e.name.startsWith('.')) return false
      if (e.isDirectory()) return true
      return includeFiles
    })

    const entries_list = filtered
      .map((e) => ({
        name: e.name,
        path: path.join(resolvedPath, e.name),
        isDirectory: e.isDirectory(),
      }))
      .sort((a, b) => {
        if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
        return a.name.localeCompare(b.name)
      })

    return json({
      currentPath: resolvedPath,
      parentPath: path.dirname(resolvedPath),
      entries: entries_list,
    })
  } catch (err) {
    return json({ error: `Cannot read directory: ${err}`, path: resolvedPath }, 500)
  }
}

//@C:ID=F.FB.json;K=F;V=1.0;P=Create JSON response helper;D=API;M=Filesystem;S=Utility;In=unknown,number;Out=Response
function json(data: unknown, status = 200): Response {
  console.log("F.FB.json");
  
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}