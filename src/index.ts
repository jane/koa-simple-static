import { createHash } from 'crypto'
import { normalize, join, basename, sep } from 'path'
import { createReadStream, statSync, readFileSync } from 'mz/fs'
import { gzip, createGzip } from 'mz/zlib'
import { lookup } from 'mime-types'
import compressible from 'compressible'
import readDir from 'fs-readdir-recursive'
import { Context } from 'koa'
import { safeDecodeURIComponent } from 'zeelib'

type StatFile = {
  dev: number
  mode: number
  nlink: number
  uid: number
  gid: number
  rdev: number
  blksize: number
  ino: number
  size: number
  blocks: number
  atimeMs: number
  mtimeMs: number
  ctimeMs: number
  birthtimeMs: number
  atime: Date
  mtime: Date
  ctime: Date
  birthtime: Date
}

type Next = () => Promise<void>

type ExtraHeader = { [key: string]: string }

const prefix = '/'

type FileOpts = {
  cacheControl?: number
  maxAge?: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const loadFile = (name: string, dir: string, options: FileOpts, files: any) => {
  const pathname = normalize(join(prefix, name))
  const obj = (files[pathname] = files[pathname] ? files[pathname] : {})
  const filename = (obj.path = join(dir, name))
  const stats = statSync(filename)
  // eslint-disable-next-line node/prefer-global/buffer
  let buffer: Buffer | null = readFileSync(filename)

  obj.cacheControl = options.cacheControl
  obj.maxAge = obj.maxAge ? obj.maxAge : options.maxAge || 0
  obj.type = obj.mime = lookup(pathname) || 'application/octet-stream'
  obj.mtime = stats.mtime
  obj.length = stats.size
  obj.md5 = createHash('md5').update(buffer).digest('base64')
  obj.buffer = buffer
  buffer = null
  return obj
}

type Opts = {
  dir: string
  extraHeaders?: Array<ExtraHeader>
  cacheControl?: number
  maxAge?: number
  gzip?: boolean
  buffer?: boolean
}

const simpleStatic = (options: Opts) => {
  const dir = normalize(options.dir)
  const files = {}

  readDir(dir).forEach((name: string): void => {
    loadFile(name, dir, options, files)
  })

  // eslint-disable-next-line max-statements
  return async (ctx: Context, next: Next): Promise<void> => {
    // only accept HEAD and GET
    if (!['HEAD', 'GET'].includes(ctx.method)) {
      await next()
      return
    }

    // check prefix first to avoid calculate
    if (!ctx.path.startsWith(prefix)) {
      await next()
      return
    }

    if (
      options.extraHeaders &&
      Array.isArray(options.extraHeaders) &&
      options.extraHeaders.length
    ) {
      options.extraHeaders.forEach((header: ExtraHeader): void => {
        // eslint-disable-next-line fp/no-loops, guard-for-in
        for (const h in header) {
          // eslint-disable-line guard-for-in
          ctx.append(h, header[h])
        }
      })
    }

    // decode for `/%E4%B8%AD%E6%96%87`
    // normalize for `//index`
    let filename: string = safeDecodeURIComponent(normalize(ctx.path))

    /* eslint-disable @typescript-eslint/no-explicit-any */
    // @ts-ignore this indexing is fine
    let file: any = files[filename]
    /* eslint-any @typescript-eslint/no-explicit-any */

    // try to load file
    if (!file) {
      if (basename(filename).startsWith('.')) {
        await next()
        return
      }

      // handle index.html
      let hasIndex: boolean = false
      try {
        /* eslint-disable @typescript-eslint/await-thenable */
        // @ts-ignore isFile is not in the types
        hasIndex = await statSync(
          normalize(join(dir, `${filename}/index.html`))
        ).isFile()
        /* eslint-enable @typescript-eslint/await-thenable */
      } catch {}
      if (hasIndex) {
        filename = `${filename}/index.html`
      }

      if (filename.startsWith(sep)) {
        filename = filename.slice(1)
      }

      // disallow ../
      const fullPath = join(dir, filename)
      if (!fullPath.startsWith(dir) && fullPath !== 'index.html') {
        await next()
        return
      }

      let s: StatFile
      try {
        // eslint-disable-next-line @typescript-eslint/await-thenable
        s = await statSync(join(dir, filename))
      } catch {
        await next()
        return
      }
      // @ts-ignore isFile is not in the types
      if (!s.isFile()) {
        await next()
        return
      }

      file = loadFile(filename, dir, options, files)
    }

    ctx.status = 200
    ctx.vary('Accept-Encoding')

    if (!file.buffer) {
      // eslint-disable-next-line @typescript-eslint/await-thenable
      const stats = await statSync(file.path)
      if (stats.mtime > file.mtime) {
        file.mtime = stats.mtime
        file.md5 = null
        file.length = stats.size
      }
    }

    ctx.response.lastModified = file.mtime

    if (file.md5) {
      ctx.response.etag = file.md5
    }

    if (ctx.fresh) {
      ctx.status = 304
      return
    }

    ctx.type = file.type
    ctx.length = file.zipBuffer ? file.zipBuffer.length : file.length
    ctx.set('cache-control', `public, max-age=${file.maxAge}`)

    if (file.md5) {
      ctx.set('content-md5', file.md5)
    }

    if (ctx.method === 'HEAD') {
      return
    }

    const acceptGzip = ctx.acceptsEncodings('gzip') === 'gzip'

    if (file.zipBuffer) {
      if (acceptGzip) {
        ctx.set('content-encoding', 'gzip')
        ctx.body = file.zipBuffer
      } else {
        ctx.body = file.buffer
      }
      return
    }

    const shouldGzip =
      file.length > 1024 && acceptGzip && compressible(file.type)

    if (file.buffer) {
      if (shouldGzip) {
        file.zipBuffer = await gzip(file.buffer)
        ctx.set('content-encoding', 'gzip')
        ctx.body = file.zipBuffer
      } else {
        ctx.body = file.buffer
      }
      return
    }

    // eslint-disable-next-line @typescript-eslint/await-thenable
    const stream = await createReadStream(file.path)

    // update file hash
    if (!file.md5) {
      const hash = createHash('md5')
      stream.on('data', hash.update.bind(hash))
      stream.on('end', (): void => {
        file.md5 = hash.digest('base64')
      })
    }

    ctx.body = stream
    // enable gzip will remove content length
    if (shouldGzip) {
      ctx.remove('content-length')
      ctx.set('content-encoding', 'gzip')
      ctx.body = stream.pipe(createGzip())
    }
  }
}

export default simpleStatic
