# Ginotate

A lightweight, embeddable screenshot and annotation widget for web applications. Drop a single script tag into any page and give users the ability to capture screenshots, annotate them, and submit feedback.

## Features

- **Screenshot capture**: Full page, visible viewport, or custom area selection
- **Annotation tools**: Pen, rectangle, arrow, and highlighter with 6 colors
- **Draggable button**: Position the feedback button anywhere on screen
- **Settings panel**: Users can customize appearance and save preferences
- **Cookie persistence**: User settings persist across pages and sessions
- **Three config methods**: HTML attributes, JavaScript, or zero-config
- **Zero dependencies**: Self-contained, loads html2canvas dynamically
- **Rich metadata**: Captures browser info, viewport, URL, timezone, and more
- **Custom variables**: Include your app's data (user ID, session, etc.)

## Live Demo

See Ginotate in action at **[ginotate.com](https://ginotate.com)**

### No Backend? No Problem!

Don't want to build your own API to receive feedback submissions? Use the free hosted service at **[ginotate.com](https://ginotate.com)** — just sign up, grab your API key, and start collecting feedback in minutes. Zero backend code required.

## Quick Start

### Option 1: Zero Configuration

Just embed the script - everything uses sensible defaults:

```html
<script src="ginotate.js" defer></script>
```

Users can customize everything via the Settings panel (gear icon in menu).

### Option 2: HTML Attributes

Configure via `gino-*` attributes:

```html
<script
  src="ginotate.js"
  gino-apiKey="your-api-key"
  gino-apiSecret="your-secret"
  gino-defaultTitle="Project ABC"
  gino-color="blue"
  gino-icon="bug"
  defer>
</script>
```

### Option 3: JavaScript Configuration

For dynamic values (auth tokens, user data, etc.):

```html
<script>
  window.ginotateConfig = {
    apiKey: getAuthToken(),
    apiSecret: getApiSecret(),
    endpoint: 'https://api.example.com/feedback',
    color: 'blue',
    testerId: getCurrentUser().name,
    defaultTitle: 'Project ABC'
  };
</script>
<script src="ginotate.js" defer></script>
```

Can also be a function for lazy evaluation:

```javascript
window.ginotateConfig = () => ({
  apiKey: sessionStorage.getItem('api_key'),
  testerId: localStorage.getItem('user_name')
});
```

## Configuration Priority

Settings are applied in this order (highest priority first):

1. **Cookie** - User preferences from Settings panel
2. **window.ginotateConfig** - JavaScript configuration
3. **gino-* attributes** - HTML attributes
4. **Defaults** - Built-in fallbacks

This means users can always override developer defaults via the Settings panel.

## All Configuration Options

| Property | Attribute | Default | Description |
|----------|-----------|---------|-------------|
| `testerId` | `gino-testerId` | `''` | Pre-fill tester name field |
| `defaultTitle` | `gino-defaultTitle` | `''` | Pre-fill title field (e.g. project name) |
| `endpoint` | `gino-endpoint` | Auto-detect | Submission URL |
| `apiKey` | `gino-apiKey` | `''` | API key (`X-API-Key` header) |
| `apiSecret` | `gino-apiSecret` | `''` | API secret (`X-API-Secret` header) |
| `icon` | `gino-icon` | `'flag'` | `flag`, `bug`, `pencil`, `target`, `magnifier` |
| `color` | `gino-color` | `'purple'` | `purple`, `red`, `orange`, `yellow`, `green`, `blue`, `pink`, `black` |
| `size` | `gino-size` | `'medium'` | `small` (40px), `medium` (56px), `large` (72px) |
| `shape` | `gino-shape` | `'circle'` | `circle`, `rounded`, `pill` |
| `opacity` | `gino-opacity` | `1` | `0` to `1` (becomes solid on hover) |
| `pulse` | `gino-pulse` | `false` | `true` enables pulse animation |
| `title` | `gino-title` | `'Send Feedback'` | Modal header text |
| `categories` | `gino-categories` | 5 defaults | Comma-separated list (max 10) |
| `vars` | `gino-vars` | `[]` | Global variable names to capture |
| `demoMode` | `gino-demoMode` | `false` | Simulate submissions without sending to server |

## Draggable Button

The feedback button can be **dragged anywhere on screen**. Simply click and drag it to your preferred position:

- Position is saved automatically and persists across page loads
- If dragged off-screen, it resets to the bottom-right corner
- When the window is resized, the button stays visible (clamped to viewport)
- The fan menu automatically adjusts its direction based on where the button is positioned

To reset the button position, open Settings and click "Reset to Bottom-Right Corner".

## Settings Panel

Users can access the Settings panel via the gear icon in the fan menu. The panel allows customization of:

- **Identity**: Tester name, default title (persist across submissions)
- **Appearance**: Size, shape, color, icon, opacity, pulse
- **Content**: Modal title, categories
- **API**: Endpoint, API key, API secret, custom variables

### Override Indicators

When a user changes a setting, the panel shows:
- Orange highlight on overridden fields
- "Overrides code default: X" hint text
- Per-field reset button to restore the code default
- "Reset All" button to clear all user customizations

## Custom Variables

Include your application's data in feedback submissions:

**Method 1: List global variables**

```html
<script
  src="ginotate.js"
  gino-vars="userId,sessionId,appVersion"
  defer>
</script>
```

**Method 2: Use the ginotate bucket**

```javascript
window.ginotate = {
  userId: 123,
  plan: 'premium',
  environment: 'staging'
};

// Or as a function for dynamic values
window.ginotate = () => ({
  userId: getCurrentUser()?.id,
  cartItems: getCart().length
});
```

Both methods can be combined. Values appear in the `customVars` field of the payload.

## Annotation Tools

Click the screenshot preview to open the annotation editor:

| Tool | Description |
|------|-------------|
| **Pen** | Freehand drawing |
| **Rectangle** | Click and drag to draw outlined rectangles |
| **Arrow** | Click and drag to draw arrows with arrowheads |
| **Highlighter** | Semi-transparent thick stroke |

Six colors available: red, orange, yellow, green, blue, black.

## Payload Structure

Submissions POST the following JSON:

```json
{
  "apiVersion": 1,
  "testerName": "John Doe",
  "title": "Button not working",
  "description": "The submit button doesn't respond",
  "categories": ["bug"],
  "screenshot": "data:image/png;base64,...",
  "screenshotWidth": 1920,
  "screenshotHeight": 1080,
  "metadata": {
    "pageUrl": "https://example.com/page",
    "pageTitle": "Example Page",
    "referrer": "https://example.com/home",

    "viewportWidth": 1920,
    "viewportHeight": 1080,
    "screenWidth": 2560,
    "screenHeight": 1440,
    "devicePixelRatio": 2,
    "colorDepth": 24,
    "orientation": "landscape-primary",

    "userAgent": "Mozilla/5.0...",
    "platform": "MacIntel",
    "language": "en-US",
    "languages": ["en-US", "en"],
    "cookiesEnabled": true,
    "doNotTrack": null,

    "prefersColorScheme": "dark",
    "prefersReducedMotion": false,

    "connection": {
      "effectiveType": "4g",
      "downlink": 10,
      "rtt": 50,
      "saveData": false
    },

    "timestamp": "2025-01-01T12:00:00.000Z",
    "timezone": "America/New_York",
    "timezoneOffset": 300,

    "scrollX": 0,
    "scrollY": 150,
    "documentHeight": 4500,
    "documentWidth": 1920
  },
  "customVars": {
    "userId": 123,
    "sessionId": "abc-456"
  }
}
```

| Field | Description |
|-------|-------------|
| `apiVersion` | API version number (for backwards compatibility) |
| `testerName` | Name entered by user (nullable) |
| `title` | Feedback title (required) |
| `description` | Detailed description (nullable) |
| `categories` | Array of selected category strings |
| `screenshot` | Base64 PNG data URL |
| `screenshotWidth` | Screenshot width in pixels |
| `screenshotHeight` | Screenshot height in pixels |
| `metadata` | Auto-collected environment data (see above) |
| `customVars` | Your custom variables (if configured) |

**Headers sent:**
- `Content-Type: application/json`
- `X-API-Key: <apiKey>` (if configured)
- `X-API-Secret: <apiSecret>` (if configured)

## FAQ

### Where should I host ginotate.js?

You have several options, each with trade-offs:

#### Option 1: Download and Self-Host (Recommended)

Download `ginotate.js` and add it to your project like any other file:

```html
<script src="/assets/js/ginotate.js" defer></script>
```

**Pros:**
- Full control over versioning
- No external dependencies
- Best screenshot quality (no cross-origin issues)
- Works offline

**Cons:**
- Manual updates when new versions release

---

#### Option 2: jsDelivr CDN

[jsDelivr](https://www.jsdelivr.com/) automatically mirrors GitHub repos with CDN caching:

```html
<!-- Specific version (recommended) -->
<script src="https://cdn.jsdelivr.net/gh/flevanti/ginotate@0.6.0/ginotate.js" defer></script>

<!-- Latest 0.x.x (auto-updates minor/patch) -->
<script src="https://cdn.jsdelivr.net/gh/flevanti/ginotate@0/ginotate.js" defer></script>

<!-- Latest (use with caution) -->
<script src="https://cdn.jsdelivr.net/gh/flevanti/ginotate/ginotate.js" defer></script>
```

**Pros:**
- Fast global CDN
- Semantic versioning support
- Auto-minification available (`ginotate.min.js`)

**Cons:**
- External dependency
- Cross-origin restrictions on screenshots (see below)

---

#### Option 3: GitHub Raw

Link directly to the file on GitHub:

```html
<!-- Specific tag/release -->
<script src="https://raw.githubusercontent.com/flevanti/ginotate/v0.6.0/ginotate.js" defer></script>

<!-- Specific commit -->
<script src="https://raw.githubusercontent.com/flevanti/ginotate/a29843f/ginotate.js" defer></script>

<!-- Main branch (not recommended - can break) -->
<script src="https://raw.githubusercontent.com/flevanti/ginotate/main/ginotate.js" defer></script>
```

**Pros:**
- Simple, direct link
- Version control via tags/commits

**Cons:**
- No CDN (slower)
- Rate limits on high traffic
- Cross-origin restrictions on screenshots

---

#### Cross-Origin Screenshot Warning

When loading ginotate.js from an external domain (jsDelivr, GitHub, etc.), **cross-origin images and content on your page may appear blank in screenshots**.

This is a browser security feature called "canvas tainting." The screenshot capture works, but any images loaded from other domains won't render.

**Solutions:**
- **Self-host ginotate.js** (eliminates the issue)
- Ensure your images have CORS headers (`Access-Control-Allow-Origin: *`)
- Add `crossorigin="anonymous"` to your `<img>` tags
- Host images on the same domain as your page

| Hosting Method | Screenshot Quality |
|---------------|-------------------|
| Self-hosted (same domain) | All content renders |
| External CDN/GitHub | Cross-origin images may be blank |

### Why aren't my settings persisting?

**Most likely: You're opening HTML files directly** (`file:///path/to/page.html`).

Cookies don't work reliably with the `file://` protocol. Use a local web server instead:

```bash
# Python
python3 -m http.server 8080

# Node.js
npx serve .

# Then open http://localhost:8080/your-page.html
```

### Do I need to configure CORS?

**Only on your API server** (the endpoint receiving submissions).

If your page is at `https://app.example.com` and submissions go to `https://api.example.com/feedback`, your API needs to return:

```
Access-Control-Allow-Origin: https://app.example.com
Access-Control-Allow-Headers: Content-Type, X-API-Key, X-API-Secret
```

If everything is on the same domain, no CORS configuration is needed.

### Why are some images blank in screenshots?

**Cross-origin images** in your page may not render in screenshots due to browser security (canvas tainting).

Solutions:
- Host images on the same domain
- Ensure images have proper CORS headers (`Access-Control-Allow-Origin`)
- Use `crossorigin="anonymous"` attribute on `<img>` tags

### Can users disable the feedback button?

Not directly, but you can:
- Conditionally include the script based on user preferences
- Use CSS to hide it: `.ft-button { display: none !important; }`

### How do I update the configuration after page load?

Currently, configuration is read once at initialization. To change settings:
- Users can use the Settings panel
- For programmatic changes, reload the page with new `window.ginotateConfig` values

### What browsers are supported?

All modern browsers: Chrome, Firefox, Safari, Edge. Requires JavaScript enabled.

### How big is the script?

The main script is ~60KB unminified. It dynamically loads `html2canvas` (~40KB) from CDN only when capturing screenshots.

## File Structure

```
├── ginotate.js    # The embeddable widget
├── LICENSE        # License terms
└── README.md      # This file
```

## Contributing

If you improve this tool or extend its functionality, contributions back are welcome! You can:

- Open a pull request on [GitHub](https://github.com/flevanti/ginotate)
- Request new features via [GitHub Issues](https://github.com/flevanti/ginotate/issues)
- Reach out through the [contact form](https://ginotate.com/contact)

## License

MIT License - free to use for any purpose. See [LICENSE](LICENSE) for details.
