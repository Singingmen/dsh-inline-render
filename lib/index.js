/**
 * dsh-inline-render —— 让 DSH 主对话「内联出图」。
 *
 * 背景（ADR-0111）
 * ---------------
 * DSH 的对话内 Markdown 渲染器**故意不支持**内联 HTML/SVG：
 *   - 裸 `<svg>`   → `dsh-client-ui-primitives` 里 `case "html": return node.value`
 *                    ⇒ React 把字符串子节点**转义**输出（渲染器根本没有 HTML 分支）
 *   - `data:` 图片 → `remoteImageUrl()` 只放行 http/https
 *   - 本地路径     → 主对话传的是 `pathImages: void 0`（只有侧边栏文档预览才传）
 *
 * **但绝对 http(s) 图片是放行的。** 所以本插件在宿主进程内起一个只监听
 * 127.0.0.1 的静态服务，并注册一个工具把 SVG/图片写进去、返回可直接粘贴的
 * Markdown —— 一次工具调用即可在对话内出图。
 *
 * 设计取舍
 * --------
 * * **不用 `@deepseek-ai/dsh-tools` 之外的重依赖**：不 spawn 外部进程（不依赖 python）。
 * * **服务在宿主进程内**：随 DSH 生死，无需单独守护；`dispose` 时关闭。
 * * **模块级单例**：`apply()` 可能被多个 agent 作用域各调一次，服务只起一个。
 */

import http from "node:http";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";

/** Stable Loader identity. */
const name = "inline-render";

const DEFAULT_DIR = path.join(process.env.DSH_HOME ?? path.join(os.homedir(), ".dsh"), "inline-render");

/** 允许的内联媒体类型 → 扩展名。SVG 是主用途。 */
const MEDIA = {
	"image/svg+xml": ".svg",
	"image/png": ".png",
	"image/jpeg": ".jpg",
	"image/webp": ".webp",
	"image/gif": ".gif",
};

const Config = z.object({
	port: z.natural().default(8899),
	host: z.string().default("127.0.0.1"),
	dir: z.string().default(""),
});

const inject = ["tools"];

/** 进程级单例：服务、根目录、以及每个端口对应的关闭句柄。 */
let server = null;
let rootDir = null;

const contentTypeOf = (file) => {
	const ext = path.extname(file).toLowerCase();
	for (const [media, e] of Object.entries(MEDIA)) if (e === ext) return media;
	if (ext === ".html") return "text/html; charset=utf-8";
	if (ext === ".json") return "application/json; charset=utf-8";
	if (ext === ".txt" || ext === ".md") return "text/plain; charset=utf-8";
	return "application/octet-stream";
};

/** 把请求路径解析到根目录内的绝对路径；越界或非法编码一律 undefined。 */
function resolveWithin(root, requestPath) {
	let rel;
	try {
		rel = decodeURIComponent(requestPath);
	} catch {
		return undefined;
	}
	if (rel.includes("\0")) return undefined;
	// strip leading slashes, then resolve and re-check containment
	const abs = path.resolve(root, "." + path.posix.normalize("/" + rel.replace(/\\/g, "/")));
	const withSep = root.endsWith(path.sep) ? root : root + path.sep;
	return abs.startsWith(withSep) || abs === root ? abs : undefined;
}

function startServer(config) {
	if (server !== null) return server;
	rootDir = path.resolve(config.dir.length > 0 ? config.dir : DEFAULT_DIR);
	fs.mkdirSync(rootDir, { recursive: true });

	const httpServer = http.createServer((req, res) => {
		const send = (code, body, type = "text/plain; charset=utf-8") => {
			res.writeHead(code, {
				"Content-Type": type,
				"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
				Pragma: "no-cache",
				Expires: "0",
				"X-Content-Type-Options": "nosniff",
			});
			res.end(body);
		};
		if (req.method !== "GET" && req.method !== "HEAD") return send(405, "method not allowed");
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (url.pathname === "/" || url.pathname === "/index.json") {
			const entries = fs.readdirSync(rootDir).filter((f) => !f.startsWith("."));
			return send(200, JSON.stringify({ dir: rootDir, files: entries }, null, 2), "application/json; charset=utf-8");
		}
		const abs = resolveWithin(rootDir, url.pathname);
		if (abs === undefined) return send(403, "forbidden");
		let stat;
		try {
			stat = fs.statSync(abs);
		} catch {
			return send(404, "not found");
		}
		if (!stat.isFile()) return send(404, "not a file");
		const body = fs.readFileSync(abs);
		res.writeHead(200, {
			"Content-Type": contentTypeOf(abs),
			"Content-Length": body.byteLength,
			"Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
			Pragma: "no-cache",
			Expires: "0",
			"X-Content-Type-Options": "nosniff",
		});
		res.end(req.method === "HEAD" ? undefined : body);
	});

	httpServer.on("error", (error) => {
		// 端口被占：不拖垮宿主，只标记不可用，工具调用时给出可读错误
		server = null;
		rootDir = null;
		ctxError = error;
	});
	httpServer.listen(config.port, config.host);
	server = httpServer;
	return httpServer;
}

let ctxError = null;

/**
 * Register the inline-render tool and the loopback media route.
 * @param ctx - agent-scoped services.
 * @param config - validated plugin configuration.
 */
function apply(ctx, config) {
	if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65535) {
		throw new Error("inline-render requires a TCP port between 1 and 65535");
	}
	let httpServer = null;
	try {
		httpServer = startServer(config);
	} catch (error) {
		ctxError = error;
	}
	const base = `http://${config.host}:${config.port}`;
	const dir = rootDir ?? path.resolve(config.dir.length > 0 ? config.dir : DEFAULT_DIR);

	ctx.tools.register(defineTool({
		name: "inline_render",
		description:
			"Render an SVG (or a raster image) INLINE in the conversation. Writes the asset to a "
			+ "loopback-only media route and returns a Markdown image reference you must paste "
			+ "verbatim into your reply. Use this whenever a diagram, chart, or card layout is "
			+ "clearer than prose. Art is served statically, so it cannot run scripts or respond "
			+ "to interaction. The route lives only as long as this DSH process.",
		parameters: {
			name: {
				type: "string",
				required: true,
				description: "Asset file name without extension, e.g. \"model-diagram\". Reused names overwrite.",
			},
			svg: {
				type: "string",
				description: "SVG source. Provide this or image_base64. Must start with <svg.",
			},
			image_base64: {
				type: "string",
				description: "Base64 raster bytes. Requires media_type. Ignored when svg is present.",
			},
			media_type: {
				type: "string",
				description: "One of image/svg+xml, image/png, image/jpeg, image/webp, image/gif. Required with image_base64.",
			},
			title: {
				type: "string",
				description: "Alt text for the Markdown reference; keep it short.",
			},
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					url: { type: "string", required: true },
					markdown: { type: "string", required: true },
					path: { type: "string", required: true },
					bytes: { type: "integer", required: true },
				},
			},
			render: (_args, value) => [{
				type: "text",
				text: `Rendered inline at ${value.url} (${value.bytes} bytes). Paste this into your reply:\n\n${value.markdown}`,
			}],
		},
		async execute(args) {
			if (server === null) {
				throw new Error(`inline-render media route is not serving (port ${config.port} unavailable)`
					+ (ctxError === null ? "" : `: ${ctxError.message}`));
			}
			const stem = args.name.trim();
			if (stem.length === 0) throw new Error("inline_render requires a non-empty name");
			if (/[\\/]/.test(stem) || stem.startsWith(".")) {
				throw new Error("inline_render name must be a plain file name (no path separators, no leading dot)");
			}
			let buffer;
			let media;
			if (args.svg !== undefined && args.svg.trim().length > 0) {
				const source = args.svg.trim();
				if (!source.startsWith("<svg")) throw new Error("inline_render svg must start with <svg");
				buffer = Buffer.from(source, "utf8");
				media = "image/svg+xml";
			} else if (args.image_base64 !== undefined && args.image_base64.trim().length > 0) {
				media = args.media_type;
				if (media === undefined || MEDIA[media] === undefined || media === "image/svg+xml") {
					throw new Error("inline_render media_type must be one of image/png, image/jpeg, image/webp, image/gif");
				}
				buffer = Buffer.from(args.image_base64.trim(), "base64");
				if (buffer.byteLength === 0) throw new Error("inline_render image_base64 decoded to zero bytes");
			} else {
				throw new Error("inline_render requires either svg or image_base64");
			}
			const file = path.join(dir, stem + MEDIA[media]);
			await fsp.writeFile(file, buffer);
			const assetPath = `/${encodeURIComponent(stem + MEDIA[media])}`;
			const url = `${base}${assetPath}`;
			const alt = args.title === undefined || args.title.trim().length === 0 ? stem : args.title.trim();
			return {
				url,
				markdown: `![${alt}](${url})`,
				path: file,
				bytes: buffer.byteLength,
			};
		},
	}));

	ctx.on("dispose", () => {
		// 只在最后一个作用域释放时真正关闭：其他作用域仍可能持有工具
		if (httpServer === null) return;
		httpServer.close();
		server = null;
		rootDir = null;
	});
}

export { Config, apply, inject, name };
