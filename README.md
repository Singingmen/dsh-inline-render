# dsh-inline-render

> **让 DSH 主对话「内联出图」** —— 一次工具调用，SVG/PNG 直接出现在对话里。
> 零外部依赖（不 spawn 进程、不依赖 Python），随 DSH 宿主进程生死。

---

## 它解决什么

DSH 的对话内 Markdown 渲染器**故意**不支持内联 HTML/SVG，三条路全堵（ADR-0089 / ADR-0111 代码级确认）：

| 写法 | 结果 | 代码级根因 |
|---|---|---|
| 裸 `<svg>` / `<div>` | 显示为**纯文本** | `dsh-client-ui-primitives`：`case "html": return node.value` ⇒ React 把字符串**转义**输出；渲染器**根本没有 HTML 分支** |
| `![](data:image/svg+xml,…)` | **只剩 alt 文字** | `remoteImageUrl()` 只放行 `http:`/`https:` |
| ` ```mermaid ` | 普通代码块 | 无渲染器插件 |

**但绝对 `http(s)://` 图片是放行的。** 本插件在宿主进程内起一个**只监听 `127.0.0.1`** 的静态服务，并注册工具 `inline_render` 把资源写进去、返回可直接粘贴的 Markdown。

```
你（模型）                          用户
   │                                 │
   ├─ inline_render({name, svg}) ──► 写文件 + 返回 markdown
   │                                 │
   └─ 把 markdown 粘进回复 ─────────► 对话内直接看到图 ✅
```

---

## 安装

```powershell
# 1) 放包（本仓库里已在 packages/dsh-inline-render/）
# 2) 在 profile 的 package.json 里声明 link 依赖 + 追加到 dsh.profile.bundles
#    见下方「挂载」小节
# 3) 重启该 profile 的 DSH（插件在 boot 时加载）
```

### 挂载

profile 的 `package.json`：

```jsonc
{
  "dependencies": {
    "dsh-inline-render": "link:D:/Program Files (x86)/deepseek-harness/packages/dsh-inline-render"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // …原有 bundles…
        "dsh-inline-render"   // ← 追加在末尾
      ]
    }
  }
}
```

`cordis.patch.yml` 会把这个 `insert` 行合进合成树，无需手改其它文件。

---

## 工具：`inline_render`

| 参数 | 必填 | 说明 |
|---|---|---|
| `name` | ✅ | 文件名（不含扩展名），如 `model-diagram`；**同名会覆盖** |
| `svg` | 二选一 | SVG 源码，必须以 `<svg` 开头 |
| `image_base64` | 二选一 | 位图 base64；需配 `media_type` |
| `media_type` | 配 base64 | `image/png` / `image/jpeg` / `image/webp` / `image/gif` |
| `title` | | Markdown 的 alt 文本，简短即可 |

返回：

```json
{
  "url": "http://127.0.0.1:8899/model-diagram.svg",
  "markdown": "![模型图](http://127.0.0.1:8899/model-diagram.svg)",
  "path": "C:\\Users\\<你>\\.dsh\\inline-render\\model-diagram.svg",
  "bytes": 3713
}
```

**把 `markdown` 原样粘进回复即可。**

---

## 配置

```yaml
- id: inline-render
  name: 'dsh-inline-render'
  config:
    port: 8899                      # 默认 8899
    host: '127.0.0.1'               # 默认只监听回环
    dir: ''                         # 默认 %DSH_HOME%\.dsh\inline-render
```

`GET /` 返回目录清单 JSON，方便排查「文件到底写哪了」。

---

## 安全边界

| 项 | 做法 |
|---|---|
| 监听地址 | **只 `127.0.0.1`** —— 局域网/公网不可达 |
| 路径穿越 | 请求路径 decode 后 `path.resolve` 再校验**是否仍在根目录内**，越界返回 403 |
| 方法 | 只接受 `GET` / `HEAD`，其余 405 |
| 文件名 | 工具层拒绝路径分隔符与首字符 `.` |
| 缓存 | 强制 `no-store`（否则改完 SVG 看不到变化） |
| 脚本 | 只发静态文件；SVG 经 `<img>` 渲染 ⇒ **浏览器不执行其中的脚本** |

---

## 能力与边界

| 能做 | 不能做 |
|---|---|
| ✅ 任意 **SVG**（排版/配色/尺寸完全自由） | ❌ **交互**（hover / 点击 / 脚本）← 与 WorkBuddy 的**唯一实质差距** |
| ✅ PNG / JPEG / WebP / GIF | ❌ 富文本选择复制 |
| ✅ 主对话内直接显示 | ❌ 动态数据（都要重新生成文件） |
| ✅ 零插件冲突（无 client 半、无 UI） | — |

**与侧边栏路线互补**：要**交互** → 侧边栏 HTML（ADR-0089）；要**主对话一眼看到** → 本插件。

---

## ⚠️ 生命周期

路由**随 DSH 进程存活**：

* DSH 重启后**历史消息里的图会全部变破图**（服务重新起来也没用 —— 消息里存的是旧 URL，但 URL 不变，其实**会恢复**，只要端口一致且文件还在）。
* 手动 `stop` 掉进程 / 换端口 / 换机器看 → 图失效。
* 资源文件持久化在 `%DSH_HOME%\inline-render\`，**不会**随消息删除。

---

## 实测踩过的坑（写在这里免得重踩）

1. **`Start-Job` 起的服务随会话死** —— 首轮验证因此误判「不能显示」。本插件不受影响（服务在宿主进程内）。
2. **`Start-Process -FilePath 'python'` 起的进程立即退出** —— 裸 `python` 解析到的不是真解释器。本插件不需要 python。
3. **`http.server` 默认允许缓存** —— 改完 SVG 看不到变化。本插件强制 `no-store`。
4. **PowerShell 局部变量禁用 `$pid` / `$host`** —— 都是**只读自动变量**；拿它们当普通变量会导致「stop 去杀自己」或路径拼错。

---

## 参考

* **ADR-0111** —— 本插件的决策记录（四条路实测 + 4 个坑）
* **ADR-0089** —— 原始结论「DSH 不支持对话内联渲染」及其用户裁定
* `tools/inline-render/` —— 同一思路的**独立进程版**（不依赖 DSH，可脱离插件使用）
