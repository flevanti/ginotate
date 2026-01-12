/**
 * Ginotate - Embeddable screenshot & annotation feedback widget
 * Usage: <script src="ginotate.js" gino-api-key="your-key" defer></script>
 */
(function() {
  'use strict';

  // ===========================================
  // API VERSION - Update when making breaking changes
  // ===========================================
  const GINOTATE_API_VERSION = 1;

  // Cookie helpers (defined first so we can use them for config)
  const SETTINGS_COOKIE = 'gino_settings';
  const OLD_TESTER_COOKIE = 'gino_tester_name';

  function setCookie(name, value, days = 365) {
    const expires = new Date(Date.now() + days * 864e5).toUTCString();
    document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/; SameSite=Lax`;
  }

  function getCookie(name) {
    const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[2]) : '';
  }

  function deleteCookie(name) {
    document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/; SameSite=Lax`;
  }

  function getSettingsCookie() {
    try {
      const value = getCookie(SETTINGS_COOKIE);
      return value ? JSON.parse(value) : {};
    } catch (e) {
      return {};
    }
  }

  function setSettingsCookie(settings) {
    setCookie(SETTINGS_COOKIE, JSON.stringify(settings));
  }

  function clearSettingsCookie() {
    deleteCookie(SETTINGS_COOKIE);
  }

  // Migrate old tester name cookie to new settings
  (function migrateOldCookie() {
    const oldTesterName = getCookie(OLD_TESTER_COOKIE);
    if (oldTesterName) {
      const settings = getSettingsCookie();
      if (!settings.testerId) {
        settings.testerId = oldTesterName;
        setSettingsCookie(settings);
      }
      deleteCookie(OLD_TESTER_COOKIE);
    }
  })();

  // Configuration from script tag
  const scriptTag = document.currentScript;
  const attr = (name) => scriptTag?.getAttribute('gino-' + name);

  // Get dynamic config from page (if defined)
  const dynamicConfig = typeof window.ginotateConfig === 'function'
    ? window.ginotateConfig()
    : (window.ginotateConfig || {});

  // Helper to get value with priority: dynamicConfig > attribute > default
  const getConfig = (key, attrName, defaultVal, transform) => {
    if (dynamicConfig[key] !== undefined) return transform ? transform(dynamicConfig[key]) : dynamicConfig[key];
    const attrVal = attr(attrName);
    if (attrVal !== null) return transform ? transform(attrVal) : attrVal;
    return defaultVal;
  };

  // Build code defaults (from dynamicConfig and attributes)
  const codeDefaults = {
    testerId: getConfig('testerId', 'testerId', ''),
    defaultTitle: getConfig('defaultTitle', 'defaultTitle', ''),
    endpoint: dynamicConfig.endpoint || attr('endpoint') || scriptTag?.src.replace(/\/[^\/]+\.js$/, '/api/submit') || '/api/submit',
    apiKey: getConfig('apiKey', 'apiKey', ''),
    apiSecret: getConfig('apiSecret', 'apiSecret', ''),
    icon: getConfig('icon', 'icon', 'flag'),
    color: getConfig('color', 'color', 'purple'),
    size: getConfig('size', 'size', 'medium'),
    pulse: getConfig('pulse', 'pulse', false, v => v === true || v === 'true'),
    opacity: getConfig('opacity', 'opacity', 1, v => parseFloat(v) || 1),
    shape: getConfig('shape', 'shape', 'circle'),
    offset: getConfig('offset', 'offset', 24, v => {
      // Support "x,y" format for coordinates or number for legacy corner offset
      if (typeof v === 'string' && v.includes(',')) return v;
      return parseInt(v) || 24;
    }),
    title: getConfig('title', 'title', 'Send Feedback'),
    categories: dynamicConfig.categories
      || (attr('categories') ? attr('categories').split(',').map(c => c.trim()).slice(0, 10) : null)
      || ['Bug', 'Improvement', 'Feature Request', 'Question', 'Other'],
    vars: dynamicConfig.vars
      || (attr('vars') ? attr('vars').split(',').map(v => v.trim()).filter(Boolean) : []),
    demoMode: getConfig('demoMode', 'demoMode', false, v => v === true || v === 'true')
  };

  // Active config: start with code defaults, then overlay cookie settings
  // Priority: cookie > dynamicConfig > attributes > hardcoded defaults
  const cookieSettings = getSettingsCookie();
  const config = { ...codeDefaults };

  // Apply cookie overrides (only for keys that exist in cookie)
  Object.keys(cookieSettings).forEach(key => {
    if (key in config) {
      config[key] = cookieSettings[key];
    }
  });

  // Position helpers for draggable button
  function getButtonSize() {
    return config.size === 'small' ? 40 : config.size === 'large' ? 72 : 56;
  }

  function parseOffset(offset) {
    if (typeof offset === 'string' && offset.includes(',')) {
      const [x, y] = offset.split(',').map(n => parseInt(n.trim()));
      return { x, y, isCoords: true };
    }
    // Legacy number = compute default bottom-right position
    const margin = typeof offset === 'number' ? offset : 24;
    const size = getButtonSize();
    return {
      x: window.innerWidth - size - margin,
      y: window.innerHeight - size - margin,
      isCoords: false
    };
  }

  function createOffset(x, y) {
    return `${Math.round(x)},${Math.round(y)}`;
  }

  // State
  let html2canvasLoaded = false;
  let currentScreenshot = null;
  let currentScreenshotDimensions = { width: null, height: null };
  let isCapturingArea = false;
  let selectionStart = null;

  // Annotation state
  let annotationEditor = null;
  let annotationState = {
    tool: 'pen',
    color: '#ff0000',
    isDrawing: false,
    startX: 0,
    startY: 0,
    lastX: 0,
    lastY: 0,
    points: []  // For highlighter path
  };
  let bgCanvas = null;
  let drawCanvas = null;
  let tempCanvas = null;

  // Load html2canvas dynamically
  function loadHtml2Canvas() {
    return new Promise((resolve, reject) => {
      if (html2canvasLoaded && window.html2canvas) {
        resolve();
        return;
      }
      const script = document.createElement('script');
      script.src = 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js';
      script.onload = () => {
        html2canvasLoaded = true;
        resolve();
      };
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // Inject styles
  function injectStyles() {
    const css = `
      /* Feedback Tool Styles - Scoped to .ft-* */
      .ft-button {
        position: fixed;
        width: 56px;
        height: 56px;
        border-radius: 50%;
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border: none;
        cursor: grab;
        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
        display: flex;
        align-items: center;
        justify-content: center;
        transition: transform 0.2s, box-shadow 0.2s;
        z-index: 999998;
      }
      .ft-button:active { cursor: grabbing; }
      /* Button colors */
      .ft-button.ft-color-purple { background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4); }
      .ft-button.ft-color-red { background: linear-gradient(135deg, #ef4444 0%, #dc2626 100%); box-shadow: 0 4px 12px rgba(239, 68, 68, 0.4); }
      .ft-button.ft-color-orange { background: linear-gradient(135deg, #f97316 0%, #ea580c 100%); box-shadow: 0 4px 12px rgba(249, 115, 22, 0.4); }
      .ft-button.ft-color-yellow { background: linear-gradient(135deg, #eab308 0%, #ca8a04 100%); box-shadow: 0 4px 12px rgba(234, 179, 8, 0.4); }
      .ft-button.ft-color-green { background: linear-gradient(135deg, #22c55e 0%, #16a34a 100%); box-shadow: 0 4px 12px rgba(34, 197, 94, 0.4); }
      .ft-button.ft-color-blue { background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%); box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4); }
      .ft-button.ft-color-pink { background: linear-gradient(135deg, #ec4899 0%, #db2777 100%); box-shadow: 0 4px 12px rgba(236, 72, 153, 0.4); }
      .ft-button.ft-color-black { background: linear-gradient(135deg, #374151 0%, #1f2937 100%); box-shadow: 0 4px 12px rgba(55, 65, 81, 0.4); }
      .ft-button:hover {
        transform: scale(1.1);
      }
      .ft-button.ft-color-purple:hover { box-shadow: 0 6px 20px rgba(102, 126, 234, 0.5); }
      .ft-button.ft-color-red:hover { box-shadow: 0 6px 20px rgba(239, 68, 68, 0.5); }
      .ft-button.ft-color-orange:hover { box-shadow: 0 6px 20px rgba(249, 115, 22, 0.5); }
      .ft-button.ft-color-yellow:hover { box-shadow: 0 6px 20px rgba(234, 179, 8, 0.5); }
      .ft-button.ft-color-green:hover { box-shadow: 0 6px 20px rgba(34, 197, 94, 0.5); }
      .ft-button.ft-color-blue:hover { box-shadow: 0 6px 20px rgba(59, 130, 246, 0.5); }
      .ft-button.ft-color-pink:hover { box-shadow: 0 6px 20px rgba(236, 72, 153, 0.5); }
      .ft-button.ft-color-black:hover { box-shadow: 0 6px 20px rgba(55, 65, 81, 0.5); }
      /* Button sizes */
      .ft-button.ft-size-small { width: 40px; height: 40px; }
      .ft-button.ft-size-small svg { width: 18px; height: 18px; }
      .ft-button.ft-size-medium { width: 56px; height: 56px; }
      .ft-button.ft-size-medium svg { width: 24px; height: 24px; }
      .ft-button.ft-size-large { width: 72px; height: 72px; }
      .ft-button.ft-size-large svg { width: 32px; height: 32px; }
      /* Button shapes */
      .ft-button.ft-shape-circle { border-radius: 50%; }
      .ft-button.ft-shape-rounded { border-radius: 12px; }
      .ft-button.ft-shape-pill { border-radius: 28px; width: auto; padding: 0 20px; }
      .ft-button.ft-shape-pill.ft-size-small { padding: 0 14px; border-radius: 20px; }
      .ft-button.ft-shape-pill.ft-size-large { padding: 0 26px; border-radius: 36px; }
      /* Pulse animation */
      @keyframes ft-pulse {
        0% { box-shadow: 0 0 0 0 currentColor; }
        70% { box-shadow: 0 0 0 12px transparent; }
        100% { box-shadow: 0 0 0 0 transparent; }
      }
      .ft-button.ft-pulse::before {
        content: '';
        position: absolute;
        inset: 0;
        border-radius: inherit;
        animation: ft-pulse 2s infinite;
      }
      .ft-button.ft-color-purple.ft-pulse::before { box-shadow: 0 0 0 0 rgba(102, 126, 234, 0.7); animation: ft-pulse-purple 2s infinite; }
      .ft-button.ft-color-red.ft-pulse::before { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); animation: ft-pulse-red 2s infinite; }
      .ft-button.ft-color-orange.ft-pulse::before { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.7); animation: ft-pulse-orange 2s infinite; }
      .ft-button.ft-color-yellow.ft-pulse::before { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.7); animation: ft-pulse-yellow 2s infinite; }
      .ft-button.ft-color-green.ft-pulse::before { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); animation: ft-pulse-green 2s infinite; }
      .ft-button.ft-color-blue.ft-pulse::before { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); animation: ft-pulse-blue 2s infinite; }
      .ft-button.ft-color-pink.ft-pulse::before { box-shadow: 0 0 0 0 rgba(236, 72, 153, 0.7); animation: ft-pulse-pink 2s infinite; }
      .ft-button.ft-color-black.ft-pulse::before { box-shadow: 0 0 0 0 rgba(55, 65, 81, 0.7); animation: ft-pulse-black 2s infinite; }
      @keyframes ft-pulse-purple { 0% { box-shadow: 0 0 0 0 rgba(102, 126, 234, 0.7); } 70% { box-shadow: 0 0 0 12px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
      @keyframes ft-pulse-red { 0% { box-shadow: 0 0 0 0 rgba(239, 68, 68, 0.7); } 70% { box-shadow: 0 0 0 12px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
      @keyframes ft-pulse-orange { 0% { box-shadow: 0 0 0 0 rgba(249, 115, 22, 0.7); } 70% { box-shadow: 0 0 0 12px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
      @keyframes ft-pulse-yellow { 0% { box-shadow: 0 0 0 0 rgba(234, 179, 8, 0.7); } 70% { box-shadow: 0 0 0 12px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
      @keyframes ft-pulse-green { 0% { box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.7); } 70% { box-shadow: 0 0 0 12px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
      @keyframes ft-pulse-blue { 0% { box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7); } 70% { box-shadow: 0 0 0 12px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
      @keyframes ft-pulse-pink { 0% { box-shadow: 0 0 0 0 rgba(236, 72, 153, 0.7); } 70% { box-shadow: 0 0 0 12px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
      @keyframes ft-pulse-black { 0% { box-shadow: 0 0 0 0 rgba(55, 65, 81, 0.7); } 70% { box-shadow: 0 0 0 12px transparent; } 100% { box-shadow: 0 0 0 0 transparent; } }
      .ft-button svg {
        width: 24px;
        height: 24px;
        fill: white;
      }

      /* Fan Menu */
      .ft-fan-menu {
        position: fixed;
        z-index: 999999;
        pointer-events: none;
      }
      .ft-fan-item {
        position: fixed;
        width: 44px;
        height: 44px;
        border-radius: 50%;
        background: white;
        border: none;
        box-shadow: 0 4px 12px rgba(0,0,0,0.15);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transform: scale(0);
        transition: transform 0.25s cubic-bezier(0.68, -0.55, 0.265, 1.55),
                    opacity 0.2s,
                    background 0.15s;
        pointer-events: none;
      }
      .ft-fan-item svg {
        width: 20px;
        height: 20px;
        fill: #667eea;
      }
      .ft-fan-item:hover {
        background: #f0f4ff;
      }
      .ft-fan-menu.ft-visible .ft-fan-item:hover {
        transform: scale(1.1);
      }
      .ft-fan-menu.ft-visible .ft-fan-item {
        opacity: 1;
        transform: scale(1);
        pointer-events: auto;
      }
      .ft-fan-menu.ft-visible .ft-fan-item:nth-child(1) { transition-delay: 0ms; }
      .ft-fan-menu.ft-visible .ft-fan-item:nth-child(2) { transition-delay: 25ms; }
      .ft-fan-menu.ft-visible .ft-fan-item:nth-child(3) { transition-delay: 50ms; }
      .ft-fan-menu.ft-visible .ft-fan-item:nth-child(4) { transition-delay: 75ms; }
      .ft-fan-menu:not(.ft-visible) .ft-fan-item:nth-child(1) { transition-delay: 75ms; }
      .ft-fan-menu:not(.ft-visible) .ft-fan-item:nth-child(2) { transition-delay: 50ms; }
      .ft-fan-menu:not(.ft-visible) .ft-fan-item:nth-child(3) { transition-delay: 25ms; }
      .ft-fan-menu:not(.ft-visible) .ft-fan-item:nth-child(4) { transition-delay: 0ms; }

      /* Button icon and label */
      .ft-button-icon {
        display: flex;
        align-items: center;
        justify-content: center;
        transition: opacity 0.15s;
      }
      .ft-button-label {
        position: absolute;
        font-size: 10px;
        font-weight: 600;
        color: white;
        white-space: nowrap;
        opacity: 0;
        transition: opacity 0.15s;
        pointer-events: none;
        text-transform: uppercase;
        letter-spacing: 0.5px;
      }
      .ft-button.ft-show-label .ft-button-label {
        opacity: 1;
      }
      .ft-button.ft-show-label .ft-button-icon {
        opacity: 0;
      }

      /* Modal Overlay */
      .ft-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.6);
        z-index: 1000000;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.3s;
        pointer-events: none;
      }
      .ft-overlay.ft-visible {
        opacity: 1;
        pointer-events: auto;
      }

      /* Modal */
      .ft-modal {
        background: white;
        border-radius: 16px;
        width: 90%;
        max-width: 600px;
        max-height: 90vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transform: scale(0.9);
        transition: transform 0.3s;
      }
      .ft-overlay.ft-visible .ft-modal {
        transform: scale(1);
      }
      .ft-modal-header {
        padding: 14px 20px;
        border-bottom: 1px solid #eee;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .ft-modal-header h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: #333;
      }
      .ft-close-btn {
        background: none;
        border: none;
        cursor: pointer;
        padding: 6px;
        border-radius: 6px;
        transition: background 0.15s;
      }
      .ft-close-btn:hover {
        background: #f0f0f0;
      }
      .ft-close-btn svg {
        width: 18px;
        height: 18px;
        fill: #666;
      }
      .ft-modal-body {
        padding: 16px 20px;
        overflow-y: auto;
        flex: 1;
      }

      /* Screenshot Preview */
      .ft-screenshot-container {
        margin-bottom: 12px;
        border-radius: 6px;
        overflow: hidden;
        border: 1px solid #e0e0e0;
        background: #f9f9f9;
        cursor: pointer;
        position: relative;
        transition: border-color 0.15s;
      }
      .ft-screenshot-container:hover {
        border-color: #667eea;
      }
      .ft-screenshot-container::after {
        content: 'Click to annotate';
        position: absolute;
        bottom: 0;
        left: 0;
        right: 0;
        background: rgba(102, 126, 234, 0.9);
        color: white;
        font-size: 11px;
        padding: 4px;
        text-align: center;
        opacity: 0;
        transition: opacity 0.15s;
      }
      .ft-screenshot-container:hover::after {
        opacity: 1;
      }
      .ft-screenshot-preview {
        width: 100%;
        max-height: 120px;
        object-fit: contain;
        display: block;
      }
      .ft-screenshot-info {
        font-size: 10px;
        color: #888;
        text-align: right;
        padding: 4px 8px;
        background: #f5f5f5;
        border-top: 1px solid #e0e0e0;
      }

      /* Form */
      .ft-form-group {
        margin-bottom: 12px;
      }
      .ft-form-group label {
        display: block;
        margin-bottom: 4px;
        font-size: 13px;
        font-weight: 500;
        color: #333;
      }
      .ft-input, .ft-textarea {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid #ddd;
        border-radius: 6px;
        font-size: 14px;
        transition: border-color 0.15s, box-shadow 0.15s;
        box-sizing: border-box;
      }
      .ft-input:focus, .ft-textarea:focus {
        outline: none;
        border-color: #667eea;
        box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
      }
      .ft-textarea {
        min-height: 60px;
        resize: vertical;
      }

      /* Categories */
      .ft-categories {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
      }
      .ft-category {
        display: inline-flex;
        align-items: center;
        gap: 4px;
        padding: 5px 10px;
        border: 1px solid #ddd;
        border-radius: 14px;
        cursor: pointer;
        transition: all 0.15s;
        font-size: 12px;
        user-select: none;
      }
      .ft-category:hover {
        border-color: #667eea;
      }
      .ft-category.ft-selected {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        color: white;
        border-color: transparent;
      }
      .ft-category input {
        display: none;
      }

      /* Metadata Details */
      .ft-metadata-details {
        margin-top: 8px;
      }
      .ft-metadata-summary {
        font-size: 11px;
        color: #888;
        cursor: pointer;
        user-select: none;
      }
      .ft-metadata-summary:hover {
        color: #667eea;
      }
      .ft-metadata-content {
        margin-top: 8px;
        padding: 10px;
        background: #f5f5f5;
        border-radius: 6px;
        font-size: 10px;
        color: #666;
        overflow-x: auto;
        max-height: 150px;
        overflow-y: auto;
        white-space: pre-wrap;
        word-break: break-all;
      }

      /* Modal Footer */
      .ft-modal-footer {
        padding: 12px 20px;
        border-top: 1px solid #eee;
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 10px;
      }
      .ft-modal-footer-buttons {
        display: flex;
        gap: 10px;
      }
      .ft-attribution {
        font-size: 11px;
        color: #999;
      }
      .ft-attribution a {
        color: #667eea;
        text-decoration: none;
      }
      .ft-attribution a:hover {
        text-decoration: underline;
      }
      .ft-api-version {
        font-size: 10px;
        color: #aaa;
        text-align: right;
        margin-top: 8px;
      }
      .ft-demo-warning {
        background: #fef3c7;
        border: 1px solid #f59e0b;
        border-radius: 6px;
        padding: 10px 16px;
        margin: 0 20px 16px;
        font-size: 12px;
        color: #92400e;
        text-align: center;
      }
      .ft-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        transition: all 0.15s;
      }
      .ft-btn-secondary {
        background: white;
        border: 1px solid #ddd;
        color: #666;
      }
      .ft-btn-secondary:hover {
        background: #f5f5f5;
      }
      .ft-btn-primary {
        background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
        border: none;
        color: white;
      }
      .ft-btn-primary:hover {
        box-shadow: 0 4px 12px rgba(102, 126, 234, 0.4);
      }
      .ft-btn-primary:disabled {
        opacity: 0.6;
        cursor: not-allowed;
      }

      /* Area Selection Overlay */
      .ft-selection-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.3);
        z-index: 1000001;
        cursor: crosshair;
      }
      .ft-selection-box {
        position: absolute;
        border: 2px dashed #667eea;
        background: rgba(102, 126, 234, 0.1);
      }
      .ft-selection-hint {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%);
        background: rgba(0,0,0,0.8);
        color: white;
        padding: 12px 24px;
        border-radius: 8px;
        font-size: 14px;
        z-index: 1000002;
      }

      /* Toast Notifications - positioned near button */
      .ft-toast {
        position: fixed;
        padding: 6px 12px;
        border-radius: 6px;
        color: white;
        font-size: 12px;
        font-weight: 500;
        z-index: 1000003;
        opacity: 0;
        transform: scale(0.9);
        transition: opacity 0.2s, transform 0.2s;
        white-space: nowrap;
        pointer-events: none;
      }
      .ft-toast.ft-visible {
        opacity: 1;
        transform: scale(1);
      }
      .ft-toast-success {
        background: #10b981;
      }
      .ft-toast-error {
        background: #ef4444;
      }

      /* Loading Spinner */
      .ft-spinner {
        display: inline-block;
        width: 16px;
        height: 16px;
        border: 2px solid rgba(255,255,255,0.3);
        border-top-color: white;
        border-radius: 50%;
        animation: ft-spin 0.8s linear infinite;
      }
      @keyframes ft-spin {
        to { transform: rotate(360deg); }
      }

      /* Annotation Editor */
      .ft-annotation-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(30, 30, 30, 0.95);
        z-index: 1000010;
        display: flex;
        flex-direction: column;
        opacity: 0;
        transition: opacity 0.2s;
        pointer-events: none;
      }
      .ft-annotation-overlay.ft-visible {
        opacity: 1;
        pointer-events: auto;
      }
      .ft-annotation-toolbar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 16px;
        background: #222;
        border-bottom: 1px solid #444;
        flex-shrink: 0;
      }
      .ft-annotation-tools {
        display: flex;
        gap: 4px;
      }
      .ft-annotation-tool {
        width: 36px;
        height: 36px;
        border: none;
        background: transparent;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: background 0.15s;
      }
      .ft-annotation-tool:hover {
        background: #444;
      }
      .ft-annotation-tool.ft-active {
        background: #667eea;
      }
      .ft-annotation-tool svg {
        width: 20px;
        height: 20px;
        fill: #ccc;
      }
      .ft-annotation-tool.ft-active svg {
        fill: white;
      }
      .ft-annotation-colors {
        display: flex;
        gap: 6px;
        margin: 0 16px;
      }
      .ft-annotation-color {
        width: 24px;
        height: 24px;
        border-radius: 50%;
        border: 2px solid transparent;
        cursor: pointer;
        transition: transform 0.15s, border-color 0.15s;
      }
      .ft-annotation-color:hover {
        transform: scale(1.15);
      }
      .ft-annotation-color.ft-active {
        border-color: white;
      }
      .ft-annotation-actions {
        display: flex;
        gap: 8px;
      }
      .ft-annotation-btn {
        padding: 8px 16px;
        border-radius: 6px;
        font-size: 13px;
        font-weight: 500;
        cursor: pointer;
        border: none;
        transition: background 0.15s;
      }
      .ft-annotation-btn-clear {
        background: #444;
        color: #ccc;
      }
      .ft-annotation-btn-clear:hover {
        background: #555;
      }
      .ft-annotation-btn-cancel {
        background: transparent;
        color: #ccc;
        border: 1px solid #555;
      }
      .ft-annotation-btn-cancel:hover {
        background: #333;
      }
      .ft-annotation-btn-done {
        background: #667eea;
        color: white;
      }
      .ft-annotation-btn-done:hover {
        background: #5a6fd6;
      }
      .ft-annotation-canvas-container {
        flex: 1;
        overflow: auto;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
      }
      .ft-annotation-canvas-wrapper {
        position: relative;
        box-shadow: 0 4px 20px rgba(0,0,0,0.5);
      }
      .ft-annotation-canvas {
        display: block;
        cursor: crosshair;
      }

      /* Settings Modal */
      .ft-settings-overlay {
        position: fixed;
        top: 0;
        left: 0;
        right: 0;
        bottom: 0;
        background: rgba(0,0,0,0.6);
        z-index: 1000000;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.3s;
        pointer-events: none;
      }
      .ft-settings-overlay.ft-visible {
        opacity: 1;
        pointer-events: auto;
      }
      .ft-settings-modal {
        background: white;
        border-radius: 16px;
        width: 90%;
        max-width: 500px;
        max-height: 90vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        transform: scale(0.9);
        transition: transform 0.3s;
      }
      .ft-settings-overlay.ft-visible .ft-settings-modal {
        transform: scale(1);
      }
      .ft-settings-header {
        padding: 14px 20px;
        border-bottom: 1px solid #eee;
        display: flex;
        align-items: center;
        justify-content: space-between;
      }
      .ft-settings-header h2 {
        margin: 0;
        font-size: 16px;
        font-weight: 600;
        color: #333;
      }
      .ft-settings-body {
        padding: 16px 20px;
        overflow-y: auto;
        flex: 1;
      }
      .ft-settings-section {
        margin-bottom: 20px;
      }
      .ft-settings-section-title {
        font-size: 11px;
        font-weight: 600;
        text-transform: uppercase;
        color: #888;
        margin-bottom: 12px;
        letter-spacing: 0.5px;
      }
      .ft-settings-row {
        display: flex;
        gap: 12px;
        margin-bottom: 12px;
      }
      .ft-settings-field {
        flex: 1;
        min-width: 0;
      }
      .ft-settings-field label {
        display: block;
        margin-bottom: 4px;
        font-size: 12px;
        font-weight: 500;
        color: #555;
      }
      .ft-settings-field-wrapper {
        position: relative;
        display: flex;
        align-items: center;
        gap: 6px;
      }
      .ft-settings-field input,
      .ft-settings-field select {
        width: 100%;
        padding: 8px 10px;
        border: 1px solid #ddd;
        border-radius: 6px;
        font-size: 13px;
        transition: border-color 0.15s;
        box-sizing: border-box;
      }
      .ft-settings-field input:focus,
      .ft-settings-field select:focus {
        outline: none;
        border-color: #667eea;
      }
      .ft-settings-field.ft-overridden input,
      .ft-settings-field.ft-overridden select {
        border-color: #f59e0b;
        background: #fffbeb;
      }
      .ft-settings-reset-btn {
        width: 28px;
        height: 28px;
        padding: 0;
        border: none;
        background: #f3f4f6;
        border-radius: 6px;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        flex-shrink: 0;
        transition: background 0.15s;
      }
      .ft-settings-reset-btn:hover {
        background: #e5e7eb;
      }
      .ft-settings-reset-btn svg {
        width: 14px;
        height: 14px;
        fill: #666;
      }
      .ft-settings-override-hint {
        font-size: 10px;
        color: #f59e0b;
        margin-top: 2px;
      }
      .ft-settings-checkbox {
        display: flex;
        align-items: center;
        gap: 8px;
        cursor: pointer;
        font-size: 13px;
        color: #333;
      }
      .ft-settings-checkbox input {
        width: 16px;
        height: 16px;
        cursor: pointer;
      }
      .ft-settings-colors {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .ft-settings-color {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        cursor: pointer;
        border: 2px solid transparent;
        transition: transform 0.15s, border-color 0.15s;
      }
      .ft-settings-color:hover {
        transform: scale(1.1);
      }
      .ft-settings-color.ft-selected {
        border-color: #333;
      }
      .ft-settings-icons {
        display: flex;
        gap: 8px;
        flex-wrap: wrap;
      }
      .ft-settings-icon {
        width: 40px;
        height: 40px;
        border-radius: 8px;
        cursor: pointer;
        border: 2px solid #ddd;
        background: white;
        display: flex;
        align-items: center;
        justify-content: center;
        transition: border-color 0.15s, background 0.15s;
      }
      .ft-settings-icon:hover {
        border-color: #667eea;
      }
      .ft-settings-icon.ft-selected {
        border-color: #667eea;
        background: #f0f4ff;
      }
      .ft-settings-icon svg {
        width: 20px;
        height: 20px;
        fill: #333;
      }
      .ft-settings-footer {
        padding: 12px 20px;
        border-top: 1px solid #eee;
        display: flex;
        justify-content: space-between;
        gap: 10px;
      }
      .ft-settings-footer-left {
        display: flex;
        gap: 10px;
      }
      .ft-settings-footer-right {
        display: flex;
        gap: 10px;
      }
      .ft-btn-danger {
        background: white;
        border: 1px solid #ef4444;
        color: #ef4444;
      }
      .ft-btn-danger:hover {
        background: #fef2f2;
      }
    `;

    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  // SVG Icons
  const icons = {
    // Button icons (customizable)
    flag: '<svg viewBox="0 0 24 24"><path d="M14.4 6L14 4H5v17h2v-7h5.6l.4 2h7V6z"/></svg>',
    bug: '<svg viewBox="0 0 24 24"><path d="M20 8h-2.81c-.45-.78-1.07-1.45-1.82-1.96L17 4.41 15.59 3l-2.17 2.17C12.96 5.06 12.49 5 12 5c-.49 0-.96.06-1.41.17L8.41 3 7 4.41l1.62 1.63C7.88 6.55 7.26 7.22 6.81 8H4v2h2.09c-.05.33-.09.66-.09 1v1H4v2h2v1c0 .34.04.67.09 1H4v2h2.81c1.04 1.79 2.97 3 5.19 3s4.15-1.21 5.19-3H20v-2h-2.09c.05-.33.09-.66.09-1v-1h2v-2h-2v-1c0-.34-.04-.67-.09-1H20V8zm-6 8h-4v-2h4v2zm0-4h-4v-2h4v2z"/></svg>',
    pencil: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    target: '<svg viewBox="0 0 24 24"><path d="M12 2C6.49 2 2 6.49 2 12s4.49 10 10 10 10-4.49 10-10S17.51 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm3-8c0 1.66-1.34 3-3 3s-3-1.34-3-3 1.34-3 3-3 3 1.34 3 3z"/></svg>',
    magnifier: '<svg viewBox="0 0 24 24"><path d="M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z"/></svg>',
    // Capture options
    fullscreen: '<svg viewBox="0 0 24 24"><path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z"/></svg>',
    visible: '<svg viewBox="0 0 24 24"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>',
    crop: '<svg viewBox="0 0 24 24"><path d="M17 15h2V7c0-1.1-.9-2-2-2H9v2h8v8zM7 17V1H5v4H1v2h4v10c0 1.1.9 2 2 2h10v4h2v-4h4v-2H7z"/></svg>',
    close: '<svg viewBox="0 0 24 24"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>',
    // Annotation tools
    pen: '<svg viewBox="0 0 24 24"><path d="M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04c.39-.39.39-1.02 0-1.41l-2.34-2.34c-.39-.39-1.02-.39-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z"/></svg>',
    rect: '<svg viewBox="0 0 24 24"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14z"/></svg>',
    arrow: '<svg viewBox="0 0 24 24"><path d="M12 4l-1.41 1.41L16.17 11H4v2h12.17l-5.58 5.59L12 20l8-8z"/></svg>',
    highlighter: '<svg viewBox="0 0 24 24"><path d="M6 14l3 3v5h6v-5l3-3V9H6v5zm5-12h2v3h-2V2zM3.5 5.88l1.41-1.41 2.12 2.12L5.62 8 3.5 5.88zm13.46.71l2.12-2.12 1.41 1.41L18.38 8l-1.42-1.41z"/></svg>',
    // Settings
    settings: '<svg viewBox="0 0 24 24"><path d="M19.14 12.94c.04-.31.06-.63.06-.94 0-.31-.02-.63-.06-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.04.31-.06.63-.06.94s.02.63.06.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z"/></svg>',
    reset: '<svg viewBox="0 0 24 24"><path d="M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z"/></svg>'
  };

  // Create floating button
  function createFloatingButton() {
    const button = document.createElement('button');
    let classes = 'ft-button ft-color-' + config.color + ' ft-size-' + config.size + ' ft-shape-' + config.shape;
    if (config.pulse) classes += ' ft-pulse';
    button.className = classes;
    button.innerHTML = `
      <span class="ft-button-icon">${icons[config.icon] || icons.flag}</span>
      <span class="ft-button-label"></span>
    `;
    button.setAttribute('aria-label', config.title);

    // Position using coordinates (draggable)
    const pos = parseOffset(config.offset);
    button.style.left = pos.x + 'px';
    button.style.top = pos.y + 'px';

    // Apply opacity
    if (config.opacity < 1) {
      button.style.opacity = config.opacity;
      button.addEventListener('mouseenter', () => button.style.opacity = '1');
      button.addEventListener('mouseleave', () => button.style.opacity = config.opacity);
    }

    // Setup drag handling (includes click handler)
    setupDrag(button);

    document.body.appendChild(button);
    return button;
  }

  // Setup drag functionality for button
  function setupDrag(button) {
    let isDragging = false;
    let startX, startY, startLeft, startTop;
    let hasMoved = false;
    const CLICK_THRESHOLD = 5;

    function onStart(e) {
      // Don't start drag if fan menu is open
      if (fanMenu && fanMenu.classList.contains('ft-visible')) return;

      isDragging = true;
      hasMoved = false;

      const touch = e.touches ? e.touches[0] : e;
      startX = touch.clientX;
      startY = touch.clientY;
      startLeft = button.offsetLeft;
      startTop = button.offsetTop;

      button.style.transition = 'none';
      e.preventDefault();
    }

    function onMove(e) {
      if (!isDragging) return;

      const touch = e.touches ? e.touches[0] : e;
      const dx = touch.clientX - startX;
      const dy = touch.clientY - startY;

      if (Math.abs(dx) > CLICK_THRESHOLD || Math.abs(dy) > CLICK_THRESHOLD) {
        hasMoved = true;
      }

      if (hasMoved) {
        button.style.left = (startLeft + dx) + 'px';
        button.style.top = (startTop + dy) + 'px';
      }
    }

    function onEnd() {
      if (!isDragging) return;
      isDragging = false;
      button.style.transition = '';

      if (hasMoved) {
        const rect = button.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;

        // Reset if center outside viewport
        if (centerX < 0 || centerX > window.innerWidth ||
            centerY < 0 || centerY > window.innerHeight) {
          resetButtonPosition();
        } else {
          // Clamp to viewport
          const x = Math.max(0, Math.min(window.innerWidth - rect.width, rect.left));
          const y = Math.max(0, Math.min(window.innerHeight - rect.height, rect.top));

          button.style.left = x + 'px';
          button.style.top = y + 'px';

          // Save position
          config.offset = createOffset(x, y);
          const settings = getSettingsCookie();
          settings.offset = config.offset;
          setSettingsCookie(settings);
        }
      }
    }

    // Mouse events
    button.addEventListener('mousedown', onStart);
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onEnd);

    // Touch events
    button.addEventListener('touchstart', onStart, { passive: false });
    document.addEventListener('touchmove', onMove, { passive: false });
    document.addEventListener('touchend', onEnd);

    // Click handler - only toggle if not dragged
    button.addEventListener('click', (e) => {
      if (!hasMoved) {
        toggleFanMenu();
      }
      hasMoved = false;
    });
  }

  // Reset button to bottom-right corner
  function resetButtonPosition() {
    const margin = 24;
    const size = getButtonSize();
    const x = window.innerWidth - size - margin;
    const y = window.innerHeight - size - margin;

    floatingButton.style.left = x + 'px';
    floatingButton.style.top = y + 'px';

    config.offset = createOffset(x, y);
    const settings = getSettingsCookie();
    settings.offset = config.offset;
    setSettingsCookie(settings);
  }

  // Create fan menu
  function createFanMenu() {
    const menu = document.createElement('div');
    menu.className = 'ft-fan-menu';

    const items = [
      { action: 'visible', icon: icons.visible, label: 'Visible' },
      { action: 'fullpage', icon: icons.fullscreen, label: 'Full Page' },
      { action: 'area', icon: icons.crop, label: 'Area' },
      { action: 'settings', icon: icons.settings, label: 'Settings' }
    ];

    items.forEach(item => {
      const btn = document.createElement('button');
      btn.className = 'ft-fan-item';
      btn.dataset.action = item.action;
      btn.dataset.label = item.label;
      btn.innerHTML = item.icon;
      menu.appendChild(btn);
    });

    // Click handlers
    menu.querySelectorAll('.ft-fan-item').forEach(item => {
      item.addEventListener('click', () => {
        const action = item.dataset.action;
        hideFanMenu();
        if (action === 'visible') captureVisible();
        else if (action === 'fullpage') captureFullPage();
        else if (action === 'area') startAreaSelection();
        else if (action === 'settings') openSettings();
      });

      // Hover to show label in main button
      item.addEventListener('mouseenter', () => {
        const label = floatingButton.querySelector('.ft-button-label');
        if (label) label.textContent = item.dataset.label;
        floatingButton.classList.add('ft-show-label');
      });

      item.addEventListener('mouseleave', () => {
        floatingButton.classList.remove('ft-show-label');
      });
    });

    document.body.appendChild(menu);
    return menu;
  }

  // Position fan items in arc
  function positionFanItems() {
    const buttonRect = floatingButton.getBoundingClientRect();
    const centerX = buttonRect.left + buttonRect.width / 2;
    const centerY = buttonRect.top + buttonRect.height / 2;

    const radius = 90;
    const items = fanMenu.querySelectorAll('.ft-fan-item');

    // Detect nearest corner dynamically, fan away from it
    const nearRight = centerX > window.innerWidth / 2;
    const nearBottom = centerY > window.innerHeight / 2;

    let startAngle, endAngle;
    if (nearRight && nearBottom) {
      startAngle = 180; endAngle = 270;  // Fan top-left
    } else if (!nearRight && nearBottom) {
      startAngle = 270; endAngle = 360;  // Fan top-right
    } else if (nearRight && !nearBottom) {
      startAngle = 90; endAngle = 180;   // Fan bottom-left
    } else {
      startAngle = 0; endAngle = 90;     // Fan bottom-right
    }

    const angleStep = (endAngle - startAngle) / (items.length - 1);

    items.forEach((item, i) => {
      const angle = (startAngle + angleStep * i) * (Math.PI / 180);
      const x = centerX + radius * Math.cos(angle) - 22;
      const y = centerY + radius * Math.sin(angle) - 22;
      item.style.left = x + 'px';
      item.style.top = y + 'px';
    });
  }

  function toggleFanMenu() {
    if (!fanMenu.classList.contains('ft-visible')) {
      positionFanItems();
    }
    fanMenu.classList.toggle('ft-visible');
  }

  function hideFanMenu() {
    fanMenu.classList.remove('ft-visible');
  }

  // Create modal
  function createModal() {
    // Generate categories HTML from config
    const categoriesHtml = config.categories.map(cat => {
      const value = cat.toLowerCase().replace(/\s+/g, '-');
      return `<label class="ft-category"><input type="checkbox" value="${value}"><span>${cat}</span></label>`;
    }).join('\n              ');

    const overlay = document.createElement('div');
    overlay.className = 'ft-overlay';
    overlay.innerHTML = `
      <div class="ft-modal">
        <div class="ft-modal-header">
          <h2>${config.title}</h2>
          <button class="ft-close-btn">${icons.close}</button>
        </div>
        <div class="ft-modal-body">
          <div class="ft-screenshot-container">
            <img class="ft-screenshot-preview" src="" alt="Screenshot">
            <div class="ft-screenshot-info"></div>
          </div>
          <div class="ft-form-group">
            <label for="ft-tester-name">Your Name</label>
            <input type="text" id="ft-tester-name" class="ft-input" placeholder="Name (saved for future submissions)">
          </div>
          <div class="ft-form-group">
            <label for="ft-title">Title *</label>
            <input type="text" id="ft-title" class="ft-input" placeholder="Brief summary of your feedback">
          </div>
          <div class="ft-form-group">
            <label for="ft-description">Description</label>
            <textarea id="ft-description" class="ft-textarea" placeholder="Provide more details..."></textarea>
          </div>
          <div class="ft-form-group">
            <label>Categories</label>
            <div class="ft-categories">
              ${categoriesHtml}
            </div>
          </div>
          <details class="ft-metadata-details">
            <summary class="ft-metadata-summary">View collected metadata</summary>
            <pre class="ft-metadata-content"></pre>
          </details>
        </div>
        <div class="ft-modal-footer">
          <div class="ft-attribution">Powered by <a href="https://ginotate.com" target="_blank" rel="noopener">Ginotate</a> · <a href="https://buymeacoffee.com/tzx12cmoho" target="_blank" rel="noopener">Buy me a coffee</a> · API v${GINOTATE_API_VERSION}</div>
          <div class="ft-modal-footer-buttons">
            <button class="ft-btn ft-btn-secondary ft-cancel-btn">Cancel</button>
            <button class="ft-btn ft-btn-primary ft-submit-btn">Submit Feedback</button>
          </div>
        </div>
        ${config.demoMode ? '<div class="ft-demo-warning">Demo Mode: Submissions are simulated and not sent to any server.</div>' : ''}
      </div>
    `;

    // Event listeners
    overlay.querySelector('.ft-close-btn').addEventListener('click', hideModal);
    overlay.querySelector('.ft-cancel-btn').addEventListener('click', hideModal);
    overlay.querySelector('.ft-submit-btn').addEventListener('click', submitFeedback);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) hideModal();
    });

    // Close modal on Escape key
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        // Close annotation editor first if open, otherwise close modal
        if (annotationEditor?.classList.contains('ft-visible')) {
          closeAnnotationEditor(false);
        } else if (modal?.classList.contains('ft-visible')) {
          hideModal();
        }
      }
    });

    // Category toggle - let the label's default behavior handle the checkbox
    overlay.querySelectorAll('.ft-category input').forEach(checkbox => {
      checkbox.addEventListener('change', () => {
        checkbox.parentElement.classList.toggle('ft-selected', checkbox.checked);
      });
    });

    // Click screenshot to annotate
    overlay.querySelector('.ft-screenshot-container').addEventListener('click', () => {
      if (currentScreenshot) {
        openAnnotationEditor(currentScreenshot);
      }
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  // DOM references
  let floatingButton, fanMenu, modal, settingsModal;

  // Show/hide modal
  function showModal(screenshotData, width, height) {
    currentScreenshot = screenshotData;
    currentScreenshotDimensions = { width, height };
    modal.querySelector('.ft-screenshot-preview').src = screenshotData;
    modal.querySelector('.ft-screenshot-info').textContent = `${width} × ${height} px`;
    modal.querySelector('#ft-tester-name').value = config.testerId || '';
    modal.querySelector('#ft-title').value = config.defaultTitle || '';
    modal.querySelector('#ft-description').value = '';
    modal.querySelectorAll('.ft-category').forEach(cat => {
      cat.classList.remove('ft-selected');
      cat.querySelector('input').checked = false;
    });
    // Populate metadata preview (including custom vars)
    const metadata = collectMetadata();
    const customVars = collectCustomVars();
    const previewData = customVars ? { ...metadata, customVars } : metadata;
    modal.querySelector('.ft-metadata-content').textContent = JSON.stringify(previewData, null, 2);
    modal.querySelector('.ft-metadata-details').removeAttribute('open');

    modal.classList.add('ft-visible');
    setTimeout(() => modal.querySelector('#ft-title').focus(), 300);
  }

  function hideModal() {
    modal.classList.remove('ft-visible');
    currentScreenshot = null;
    currentScreenshotDimensions = { width: null, height: null };
  }

  // Capture visible viewport only
  async function captureVisible() {
    try {
      await loadHtml2Canvas();

      floatingButton.style.display = 'none';
      fanMenu.style.display = 'none';

      // Capture full document then crop to visible area
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;

      const fullCanvas = await html2canvas(document.documentElement, {
        useCORS: true,
        allowTaint: true,
        scale: 1
      });

      floatingButton.style.display = '';
      fanMenu.style.display = '';

      // Crop to visible viewport
      const croppedCanvas = document.createElement('canvas');
      croppedCanvas.width = viewportWidth;
      croppedCanvas.height = viewportHeight;
      const ctx = croppedCanvas.getContext('2d');
      ctx.drawImage(
        fullCanvas,
        scrollX, scrollY, viewportWidth, viewportHeight,
        0, 0, viewportWidth, viewportHeight
      );

      showModal(croppedCanvas.toDataURL('image/png'), viewportWidth, viewportHeight);
    } catch (error) {
      console.error('Screenshot failed:', error);
      showToast('Failed to capture screenshot', 'error');
      floatingButton.style.display = '';
      fanMenu.style.display = '';
    }
  }

  // Capture full page
  async function captureFullPage() {
    try {
      await loadHtml2Canvas();

      floatingButton.style.display = 'none';
      fanMenu.style.display = 'none';

      const canvas = await html2canvas(document.documentElement, {
        useCORS: true,
        allowTaint: true,
        scale: 1
      });

      floatingButton.style.display = '';
      fanMenu.style.display = '';

      showModal(canvas.toDataURL('image/png'), canvas.width, canvas.height);
    } catch (error) {
      console.error('Screenshot failed:', error);
      showToast('Failed to capture screenshot', 'error');
      floatingButton.style.display = '';
      fanMenu.style.display = '';
    }
  }

  // Area selection
  function startAreaSelection() {
    isCapturingArea = true;

    const overlay = document.createElement('div');
    overlay.className = 'ft-selection-overlay';

    const hint = document.createElement('div');
    hint.className = 'ft-selection-hint';
    hint.textContent = 'Click and drag to select an area. Press Escape to cancel.';
    overlay.appendChild(hint);

    const selectionBox = document.createElement('div');
    selectionBox.className = 'ft-selection-box';
    selectionBox.style.display = 'none';
    overlay.appendChild(selectionBox);

    let startX, startY;

    overlay.addEventListener('mousedown', (e) => {
      startX = e.clientX;
      startY = e.clientY;
      selectionStart = { x: startX, y: startY };
      selectionBox.style.display = 'block';
      selectionBox.style.left = startX + 'px';
      selectionBox.style.top = startY + 'px';
      selectionBox.style.width = '0';
      selectionBox.style.height = '0';
    });

    overlay.addEventListener('mousemove', (e) => {
      if (!selectionStart) return;

      const currentX = e.clientX;
      const currentY = e.clientY;

      const left = Math.min(startX, currentX);
      const top = Math.min(startY, currentY);
      const width = Math.abs(currentX - startX);
      const height = Math.abs(currentY - startY);

      selectionBox.style.left = left + 'px';
      selectionBox.style.top = top + 'px';
      selectionBox.style.width = width + 'px';
      selectionBox.style.height = height + 'px';
    });

    overlay.addEventListener('mouseup', async (e) => {
      if (!selectionStart) return;

      const endX = e.clientX;
      const endY = e.clientY;

      const rect = {
        x: Math.min(startX, endX),
        y: Math.min(startY, endY),
        width: Math.abs(endX - startX),
        height: Math.abs(endY - startY)
      };

      overlay.remove();
      selectionStart = null;
      isCapturingArea = false;

      if (rect.width < 10 || rect.height < 10) {
        showToast('Selection too small', 'error');
        return;
      }

      await captureArea(rect);
    });

    // Cancel on Escape
    const handleEscape = (e) => {
      if (e.key === 'Escape') {
        overlay.remove();
        selectionStart = null;
        isCapturingArea = false;
        document.removeEventListener('keydown', handleEscape);
      }
    };
    document.addEventListener('keydown', handleEscape);

    document.body.appendChild(overlay);
  }

  // Capture selected area
  async function captureArea(rect) {
    try {
      await loadHtml2Canvas();

      floatingButton.style.display = 'none';

      // Store scroll position before capture
      const scrollX = window.scrollX;
      const scrollY = window.scrollY;

      // Capture the full document
      const fullCanvas = await html2canvas(document.documentElement, {
        useCORS: true,
        allowTaint: true,
        scale: 1
      });

      floatingButton.style.display = '';

      // Convert viewport coords to document coords
      const cropX = rect.x + scrollX;
      const cropY = rect.y + scrollY;

      // Crop to selected area
      const croppedCanvas = document.createElement('canvas');
      croppedCanvas.width = rect.width;
      croppedCanvas.height = rect.height;
      const ctx = croppedCanvas.getContext('2d');
      ctx.drawImage(
        fullCanvas,
        cropX, cropY, rect.width, rect.height,
        0, 0, rect.width, rect.height
      );

      showModal(croppedCanvas.toDataURL('image/png'), rect.width, rect.height);
    } catch (error) {
      console.error('Area capture failed:', error);
      showToast('Failed to capture area', 'error');
      floatingButton.style.display = '';
    }
  }

  // Collect metadata about the environment
  function collectMetadata() {
    const nav = navigator;
    const screen = window.screen;
    const loc = window.location;
    const doc = document;
    const conn = nav.connection || nav.mozConnection || nav.webkitConnection;

    return {
      // Page info
      pageUrl: loc.href,
      pageTitle: doc.title,
      referrer: doc.referrer || null,

      // Viewport & screen
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      screenWidth: screen.width,
      screenHeight: screen.height,
      devicePixelRatio: window.devicePixelRatio || 1,
      colorDepth: screen.colorDepth,
      orientation: screen.orientation?.type || null,

      // Browser & system
      userAgent: nav.userAgent,
      platform: nav.platform,
      language: nav.language,
      languages: nav.languages ? Array.from(nav.languages) : [nav.language],
      cookiesEnabled: nav.cookieEnabled,
      doNotTrack: nav.doNotTrack,

      // Preferences
      prefersColorScheme: window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      prefersReducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,

      // Connection (if available)
      connection: conn ? {
        effectiveType: conn.effectiveType,
        downlink: conn.downlink,
        rtt: conn.rtt,
        saveData: conn.saveData
      } : null,

      // Timing
      timestamp: new Date().toISOString(),
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),

      // Scroll position at time of capture
      scrollX: window.scrollX,
      scrollY: window.scrollY,
      documentHeight: doc.documentElement.scrollHeight,
      documentWidth: doc.documentElement.scrollWidth
    };
  }

  // Collect custom variables from window scope and ginotate bucket
  function collectCustomVars() {
    const customVars = {};

    // Option 1: Extract named variables from window (gino-vars="userId,sessionId")
    config.vars.forEach(varName => {
      if (varName in window) {
        customVars[varName] = window[varName];
      }
    });

    // Option 2: Include everything from window.ginotate bucket
    if (window.ginotate) {
      const bucket = typeof window.ginotate === 'function' ? window.ginotate() : window.ginotate;
      if (bucket && typeof bucket === 'object') {
        Object.assign(customVars, bucket);
      }
    }

    return Object.keys(customVars).length > 0 ? customVars : null;
  }

  // Submit feedback
  async function submitFeedback() {
    const testerName = modal.querySelector('#ft-tester-name').value.trim();
    const title = modal.querySelector('#ft-title').value.trim();
    const description = modal.querySelector('#ft-description').value.trim();
    const categories = Array.from(modal.querySelectorAll('.ft-category input:checked'))
      .map(cb => cb.value);

    if (!title) {
      modal.querySelector('#ft-title').focus();
      showToast('Please enter a title', 'error');
      return;
    }

    // Save tester name to settings for future submissions
    if (testerName && testerName !== config.testerId) {
      config.testerId = testerName;
      const settings = getSettingsCookie();
      settings.testerId = testerName;
      setSettingsCookie(settings);
    }

    const submitBtn = modal.querySelector('.ft-submit-btn');
    const originalText = submitBtn.textContent;
    submitBtn.disabled = true;
    submitBtn.innerHTML = '<span class="ft-spinner"></span> Sending...';

    const customVars = collectCustomVars();
    const payload = {
      apiVersion: GINOTATE_API_VERSION,
      testerName: testerName || null,
      title,
      description,
      categories,
      screenshot: currentScreenshot,
      screenshotWidth: currentScreenshotDimensions.width,
      screenshotHeight: currentScreenshotDimensions.height,
      metadata: collectMetadata(),
      customVars
    };

    try {
      // Demo mode - simulate success without actual submission
      if (config.demoMode) {
        await new Promise(resolve => setTimeout(resolve, 800));
        submitBtn.disabled = false;
        submitBtn.textContent = originalText;
        hideModal();
        showToast('Feedback submitted successfully! (Demo Mode)', 'success');
        return;
      }

      const headers = {
        'Content-Type': 'application/json'
      };
      if (config.apiKey) headers['X-API-Key'] = config.apiKey;
      if (config.apiSecret) headers['X-API-Secret'] = config.apiSecret;

      const response = await fetch(config.endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      if (response.status === 200) {
        hideModal();
        showToast('Feedback submitted successfully!', 'success');
      } else {
        const errorBody = await response.text();
        console.error('Submit failed:', {
          status: response.status,
          statusText: response.statusText,
          body: errorBody,
          endpoint: config.endpoint
        });
        showToast(`Submission failed (${response.status}). Check console for details.`, 'error');
      }
    } catch (error) {
      console.error('Submit failed:', error);
      showToast(`Submission failed: ${error.message}`, 'error');
    } finally {
      submitBtn.disabled = false;
      submitBtn.textContent = originalText;
    }
  }

  // Toast notification - positioned near the floating button
  function showToast(message, type = 'success') {
    const existing = document.querySelector('.ft-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = `ft-toast ft-toast-${type}`;
    toast.textContent = message;
    document.body.appendChild(toast);

    // Position near the floating button
    if (floatingButton) {
      const btnRect = floatingButton.getBoundingClientRect();
      const toastRect = toast.getBoundingClientRect();
      const btnCenterX = btnRect.left + btnRect.width / 2;
      const btnCenterY = btnRect.top + btnRect.height / 2;

      // Determine if button is in top or bottom half
      const showAbove = btnCenterY > window.innerHeight / 2;

      // Position horizontally centered on button, clamped to viewport
      let left = btnCenterX - toastRect.width / 2;
      left = Math.max(8, Math.min(window.innerWidth - toastRect.width - 8, left));

      // Position above or below button
      let top;
      if (showAbove) {
        top = btnRect.top - toastRect.height - 8;
      } else {
        top = btnRect.bottom + 8;
      }

      toast.style.left = left + 'px';
      toast.style.top = top + 'px';
    }

    requestAnimationFrame(() => {
      toast.classList.add('ft-visible');
    });

    setTimeout(() => {
      toast.classList.remove('ft-visible');
      setTimeout(() => toast.remove(), 300);
    }, 2500);
  }

  // Close fanMenu when clicking outside
  document.addEventListener('click', (e) => {
    if (!floatingButton?.contains(e.target) && !fanMenu?.contains(e.target)) {
      hideFanMenu();
    }
  });

  // ============ ANNOTATION EDITOR ============

  const COLORS = [
    { name: 'red', value: '#ff0000' },
    { name: 'orange', value: '#ff9500' },
    { name: 'yellow', value: '#ffcc00' },
    { name: 'green', value: '#34c759' },
    { name: 'blue', value: '#007aff' },
    { name: 'black', value: '#000000' }
  ];

  function createAnnotationEditor() {
    const overlay = document.createElement('div');
    overlay.className = 'ft-annotation-overlay';
    overlay.innerHTML = `
      <div class="ft-annotation-toolbar">
        <div class="ft-annotation-tools">
          <button class="ft-annotation-tool ft-active" data-tool="pen" title="Pen">
            ${icons.pen}
          </button>
          <button class="ft-annotation-tool" data-tool="rect" title="Rectangle">
            ${icons.rect}
          </button>
          <button class="ft-annotation-tool" data-tool="arrow" title="Arrow">
            ${icons.arrow}
          </button>
          <button class="ft-annotation-tool" data-tool="highlighter" title="Highlighter">
            ${icons.highlighter}
          </button>
        </div>
        <div class="ft-annotation-colors">
          ${COLORS.map((c, i) => `
            <div class="ft-annotation-color ${i === 0 ? 'ft-active' : ''}"
                 data-color="${c.value}"
                 style="background: ${c.value};"
                 title="${c.name}"></div>
          `).join('')}
        </div>
        <div class="ft-annotation-actions">
          <button class="ft-annotation-btn ft-annotation-btn-clear">Clear</button>
          <button class="ft-annotation-btn ft-annotation-btn-cancel">Cancel</button>
          <button class="ft-annotation-btn ft-annotation-btn-done">Done</button>
        </div>
      </div>
      <div class="ft-annotation-canvas-container">
        <div class="ft-annotation-canvas-wrapper">
          <canvas class="ft-annotation-canvas"></canvas>
        </div>
      </div>
    `;

    // Tool selection
    overlay.querySelectorAll('.ft-annotation-tool').forEach(btn => {
      btn.addEventListener('click', () => {
        overlay.querySelectorAll('.ft-annotation-tool').forEach(b => b.classList.remove('ft-active'));
        btn.classList.add('ft-active');
        annotationState.tool = btn.dataset.tool;
      });
    });

    // Color selection
    overlay.querySelectorAll('.ft-annotation-color').forEach(swatch => {
      swatch.addEventListener('click', () => {
        overlay.querySelectorAll('.ft-annotation-color').forEach(s => s.classList.remove('ft-active'));
        swatch.classList.add('ft-active');
        annotationState.color = swatch.dataset.color;
      });
    });

    // Action buttons
    overlay.querySelector('.ft-annotation-btn-clear').addEventListener('click', clearAnnotations);
    overlay.querySelector('.ft-annotation-btn-cancel').addEventListener('click', () => closeAnnotationEditor(false));
    overlay.querySelector('.ft-annotation-btn-done').addEventListener('click', () => closeAnnotationEditor(true));

    // Canvas events
    const canvas = overlay.querySelector('.ft-annotation-canvas');
    canvas.addEventListener('mousedown', handleDrawStart);
    canvas.addEventListener('mousemove', handleDrawMove);
    canvas.addEventListener('mouseup', handleDrawEnd);
    canvas.addEventListener('mouseleave', handleDrawEnd);

    document.body.appendChild(overlay);
    return overlay;
  }

  function openAnnotationEditor(imageData) {
    if (!annotationEditor) {
      annotationEditor = createAnnotationEditor();
    }

    const img = new Image();
    img.onload = () => {
      const canvas = annotationEditor.querySelector('.ft-annotation-canvas');
      const wrapper = annotationEditor.querySelector('.ft-annotation-canvas-wrapper');

      // Set canvas size to image size
      canvas.width = img.width;
      canvas.height = img.height;
      wrapper.style.width = img.width + 'px';
      wrapper.style.height = img.height + 'px';

      // Create background canvas (stores the screenshot)
      bgCanvas = document.createElement('canvas');
      bgCanvas.width = img.width;
      bgCanvas.height = img.height;
      const bgCtx = bgCanvas.getContext('2d');
      bgCtx.drawImage(img, 0, 0);

      // Create drawing canvas (stores annotations)
      drawCanvas = document.createElement('canvas');
      drawCanvas.width = img.width;
      drawCanvas.height = img.height;

      // Create temp canvas (for shape preview while drawing)
      tempCanvas = document.createElement('canvas');
      tempCanvas.width = img.width;
      tempCanvas.height = img.height;

      // Draw initial state
      renderCanvas();

      // Show editor
      annotationEditor.classList.add('ft-visible');
    };
    img.src = imageData;
  }

  function closeAnnotationEditor(save) {
    if (save && bgCanvas && drawCanvas) {
      // Merge canvases and update screenshot
      const mergedCanvas = document.createElement('canvas');
      mergedCanvas.width = bgCanvas.width;
      mergedCanvas.height = bgCanvas.height;
      const ctx = mergedCanvas.getContext('2d');
      ctx.drawImage(bgCanvas, 0, 0);
      ctx.drawImage(drawCanvas, 0, 0);

      currentScreenshot = mergedCanvas.toDataURL('image/png');
      modal.querySelector('.ft-screenshot-preview').src = currentScreenshot;
    }

    annotationEditor.classList.remove('ft-visible');
    annotationState.isDrawing = false;
  }

  function clearAnnotations() {
    if (drawCanvas) {
      const ctx = drawCanvas.getContext('2d');
      ctx.clearRect(0, 0, drawCanvas.width, drawCanvas.height);
      renderCanvas();
    }
  }

  function renderCanvas() {
    const canvas = annotationEditor.querySelector('.ft-annotation-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (bgCanvas) ctx.drawImage(bgCanvas, 0, 0);
    if (drawCanvas) ctx.drawImage(drawCanvas, 0, 0);
    if (tempCanvas) ctx.drawImage(tempCanvas, 0, 0);
  }

  function getCanvasCoords(e) {
    const canvas = annotationEditor.querySelector('.ft-annotation-canvas');
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top
    };
  }

  function handleDrawStart(e) {
    annotationState.isDrawing = true;
    const coords = getCanvasCoords(e);
    annotationState.startX = coords.x;
    annotationState.startY = coords.y;
    annotationState.lastX = coords.x;
    annotationState.lastY = coords.y;

    if (annotationState.tool === 'pen') {
      const ctx = drawCanvas.getContext('2d');
      ctx.beginPath();
      ctx.moveTo(coords.x, coords.y);
    } else if (annotationState.tool === 'highlighter') {
      annotationState.points = [{ x: coords.x, y: coords.y }];
    }
  }

  function handleDrawMove(e) {
    if (!annotationState.isDrawing) return;
    const coords = getCanvasCoords(e);

    switch (annotationState.tool) {
      case 'pen':
        drawPenStroke(coords);
        break;
      case 'highlighter':
        drawHighlighterStroke(coords);
        break;
      case 'rect':
        previewRect(coords);
        break;
      case 'arrow':
        previewArrow(coords);
        break;
    }

    annotationState.lastX = coords.x;
    annotationState.lastY = coords.y;
  }

  function handleDrawEnd(e) {
    if (!annotationState.isDrawing) return;

    const coords = getCanvasCoords(e);

    // Commit shape to draw canvas
    if (annotationState.tool === 'rect') {
      commitRect(coords);
    } else if (annotationState.tool === 'arrow') {
      commitArrow(coords);
    } else if (annotationState.tool === 'highlighter') {
      commitHighlighter();
    }

    // Clear temp canvas
    if (tempCanvas) {
      const ctx = tempCanvas.getContext('2d');
      ctx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
    }

    annotationState.isDrawing = false;
    annotationState.points = [];
    renderCanvas();
  }

  // ---- Drawing Tools ----

  function drawPenStroke(coords) {
    const ctx = drawCanvas.getContext('2d');
    ctx.strokeStyle = annotationState.color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.lineTo(coords.x, coords.y);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(coords.x, coords.y);
    renderCanvas();
  }

  function drawHighlighterStroke(coords) {
    // Collect points
    annotationState.points.push({ x: coords.x, y: coords.y });

    // Preview on temp canvas
    const ctx = tempCanvas.getContext('2d');
    ctx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
    drawHighlighterPath(ctx, annotationState.points);
    renderCanvas();
  }

  function drawHighlighterPath(ctx, points) {
    if (points.length < 2) return;

    ctx.save();
    ctx.strokeStyle = annotationState.color;
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 24;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';

    ctx.beginPath();
    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
      ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.stroke();
    ctx.restore();
  }

  function commitHighlighter() {
    if (annotationState.points.length < 2) return;
    const ctx = drawCanvas.getContext('2d');
    drawHighlighterPath(ctx, annotationState.points);
  }

  function previewRect(coords) {
    const ctx = tempCanvas.getContext('2d');
    ctx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
    ctx.strokeStyle = annotationState.color;
    ctx.lineWidth = 3;
    const x = Math.min(annotationState.startX, coords.x);
    const y = Math.min(annotationState.startY, coords.y);
    const w = Math.abs(coords.x - annotationState.startX);
    const h = Math.abs(coords.y - annotationState.startY);
    ctx.strokeRect(x, y, w, h);
    renderCanvas();
  }

  function commitRect(coords) {
    const ctx = drawCanvas.getContext('2d');
    ctx.strokeStyle = annotationState.color;
    ctx.lineWidth = 3;
    const x = Math.min(annotationState.startX, coords.x);
    const y = Math.min(annotationState.startY, coords.y);
    const w = Math.abs(coords.x - annotationState.startX);
    const h = Math.abs(coords.y - annotationState.startY);
    ctx.strokeRect(x, y, w, h);
  }

  function previewArrow(coords) {
    const ctx = tempCanvas.getContext('2d');
    ctx.clearRect(0, 0, tempCanvas.width, tempCanvas.height);
    drawArrow(ctx, annotationState.startX, annotationState.startY, coords.x, coords.y);
    renderCanvas();
  }

  function commitArrow(coords) {
    const ctx = drawCanvas.getContext('2d');
    drawArrow(ctx, annotationState.startX, annotationState.startY, coords.x, coords.y);
  }

  function drawArrow(ctx, fromX, fromY, toX, toY) {
    const headLength = 15;
    const angle = Math.atan2(toY - fromY, toX - fromX);

    ctx.strokeStyle = annotationState.color;
    ctx.fillStyle = annotationState.color;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';

    // Draw line
    ctx.beginPath();
    ctx.moveTo(fromX, fromY);
    ctx.lineTo(toX, toY);
    ctx.stroke();

    // Draw arrowhead
    ctx.beginPath();
    ctx.moveTo(toX, toY);
    ctx.lineTo(
      toX - headLength * Math.cos(angle - Math.PI / 6),
      toY - headLength * Math.sin(angle - Math.PI / 6)
    );
    ctx.lineTo(
      toX - headLength * Math.cos(angle + Math.PI / 6),
      toY - headLength * Math.sin(angle + Math.PI / 6)
    );
    ctx.closePath();
    ctx.fill();
  }

  // ============ END ANNOTATION EDITOR ============

  // ============ SETTINGS MODAL ============

  const BUTTON_COLORS = [
    { name: 'purple', bg: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' },
    { name: 'red', bg: 'linear-gradient(135deg, #ef4444 0%, #dc2626 100%)' },
    { name: 'orange', bg: 'linear-gradient(135deg, #f97316 0%, #ea580c 100%)' },
    { name: 'yellow', bg: 'linear-gradient(135deg, #eab308 0%, #ca8a04 100%)' },
    { name: 'green', bg: 'linear-gradient(135deg, #22c55e 0%, #16a34a 100%)' },
    { name: 'blue', bg: 'linear-gradient(135deg, #3b82f6 0%, #2563eb 100%)' },
    { name: 'pink', bg: 'linear-gradient(135deg, #ec4899 0%, #db2777 100%)' },
    { name: 'black', bg: 'linear-gradient(135deg, #374151 0%, #1f2937 100%)' }
  ];

  const BUTTON_ICONS = ['flag', 'bug', 'pencil', 'target', 'magnifier'];

  function createSettingsModal() {
    const overlay = document.createElement('div');
    overlay.className = 'ft-settings-overlay';
    overlay.innerHTML = `
      <div class="ft-settings-modal">
        <div class="ft-settings-header">
          <h2>Settings</h2>
          <button class="ft-close-btn ft-settings-close">${icons.close}</button>
        </div>
        <div class="ft-settings-body">
          <!-- Identity Section -->
          <div class="ft-settings-section">
            <div class="ft-settings-section-title">Identity</div>
            <div class="ft-settings-field" data-field="testerId">
              <label>Tester ID / Name</label>
              <div class="ft-settings-field-wrapper">
                <input type="text" id="ft-settings-testerId" placeholder="Your name">
                <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
              </div>
              <div class="ft-settings-override-hint"></div>
            </div>
            <div class="ft-settings-field" data-field="defaultTitle">
              <label>Default Title</label>
              <div class="ft-settings-field-wrapper">
                <input type="text" id="ft-settings-defaultTitle" placeholder="e.g. Project ABC">
                <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
              </div>
              <div class="ft-settings-override-hint"></div>
            </div>
          </div>

          <!-- Appearance Section -->
          <div class="ft-settings-section">
            <div class="ft-settings-section-title">Appearance</div>
            <div class="ft-settings-row">
              <div class="ft-settings-field">
                <label>Button Position</label>
                <div class="ft-settings-field-wrapper">
                  <button type="button" id="ft-reset-position" class="ft-btn-secondary" style="width:100%;padding:8px 12px;">
                    Reset to Bottom-Right Corner
                  </button>
                </div>
                <span class="ft-settings-hint" style="font-size:11px;color:#888;">Drag the button to move it anywhere</span>
              </div>
              <div class="ft-settings-field" data-field="size">
                <label>Size</label>
                <div class="ft-settings-field-wrapper">
                  <select id="ft-settings-size">
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                  <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
                </div>
                <div class="ft-settings-override-hint"></div>
              </div>
            </div>
            <div class="ft-settings-field" data-field="shape">
              <label>Shape</label>
              <div class="ft-settings-field-wrapper">
                <select id="ft-settings-shape">
                  <option value="circle">Circle</option>
                  <option value="rounded">Rounded</option>
                  <option value="pill">Pill</option>
                </select>
                <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
              </div>
              <div class="ft-settings-override-hint"></div>
            </div>
            <div class="ft-settings-field" data-field="icon">
              <label>Icon</label>
              <div class="ft-settings-icons" id="ft-settings-icon">
                ${BUTTON_ICONS.map(name => `
                  <div class="ft-settings-icon" data-value="${name}" title="${name}">
                    ${icons[name]}
                  </div>
                `).join('')}
              </div>
              <div class="ft-settings-override-hint"></div>
            </div>
            <div class="ft-settings-field" data-field="color">
              <label>Color</label>
              <div class="ft-settings-colors" id="ft-settings-color">
                ${BUTTON_COLORS.map(c => `
                  <div class="ft-settings-color" data-value="${c.name}" style="background: ${c.bg};" title="${c.name}"></div>
                `).join('')}
              </div>
              <div class="ft-settings-override-hint"></div>
            </div>
            <div class="ft-settings-row">
              <div class="ft-settings-field" data-field="opacity">
                <label>Opacity</label>
                <div class="ft-settings-field-wrapper">
                  <input type="range" id="ft-settings-opacity" min="0" max="1" step="0.1" style="flex:1">
                  <span id="ft-settings-opacity-value" style="width:30px;text-align:right;font-size:12px;">1</span>
                  <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
                </div>
                <div class="ft-settings-override-hint"></div>
              </div>
            </div>
            <div class="ft-settings-field" data-field="pulse">
              <label class="ft-settings-checkbox">
                <input type="checkbox" id="ft-settings-pulse">
                <span>Pulse animation</span>
              </label>
              <div class="ft-settings-override-hint"></div>
            </div>
          </div>

          <!-- Content Section -->
          <div class="ft-settings-section">
            <div class="ft-settings-section-title">Content</div>
            <div class="ft-settings-field" data-field="title">
              <label>Modal Title</label>
              <div class="ft-settings-field-wrapper">
                <input type="text" id="ft-settings-title" placeholder="Send Feedback">
                <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
              </div>
              <div class="ft-settings-override-hint"></div>
            </div>
            <div class="ft-settings-field" data-field="categories">
              <label>Categories (comma-separated)</label>
              <div class="ft-settings-field-wrapper">
                <input type="text" id="ft-settings-categories" placeholder="Bug, Feature, Question">
                <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
              </div>
              <div class="ft-settings-override-hint"></div>
            </div>
          </div>

          <!-- API Section -->
          <div class="ft-settings-section">
            <div class="ft-settings-section-title">API Configuration</div>
            <div class="ft-settings-field" data-field="endpoint">
              <label>Endpoint URL</label>
              <div class="ft-settings-field-wrapper">
                <input type="text" id="ft-settings-endpoint" placeholder="/api/submit">
                <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
              </div>
              <div class="ft-settings-override-hint"></div>
            </div>
            <div class="ft-settings-row">
              <div class="ft-settings-field" data-field="apiKey">
                <label>API Key</label>
                <div class="ft-settings-field-wrapper">
                  <input type="text" id="ft-settings-apiKey" placeholder="API Key">
                  <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
                </div>
                <div class="ft-settings-override-hint"></div>
              </div>
              <div class="ft-settings-field" data-field="apiSecret">
                <label>API Secret</label>
                <div class="ft-settings-field-wrapper">
                  <input type="password" id="ft-settings-apiSecret" placeholder="API Secret">
                  <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
                </div>
                <div class="ft-settings-override-hint"></div>
              </div>
            </div>
            <div class="ft-settings-field" data-field="vars">
              <label>Custom Variables (comma-separated)</label>
              <div class="ft-settings-field-wrapper">
                <input type="text" id="ft-settings-vars" placeholder="userId, sessionId">
                <button class="ft-settings-reset-btn" title="Reset to default">${icons.reset}</button>
              </div>
              <div class="ft-settings-override-hint"></div>
            </div>
            <div class="ft-settings-field" data-field="demoMode">
              <label class="ft-settings-checkbox">
                <input type="checkbox" id="ft-settings-demoMode">
                <span>Demo Mode (simulate submissions)</span>
              </label>
              <div class="ft-settings-override-hint"></div>
            </div>
            <div class="ft-api-version">API v${GINOTATE_API_VERSION}</div>
          </div>
        </div>
        <div class="ft-settings-footer">
          <div class="ft-settings-footer-left">
            <button class="ft-btn ft-btn-danger ft-settings-reset-all">Reset All</button>
          </div>
          <div class="ft-settings-footer-right">
            <button class="ft-btn ft-btn-secondary ft-settings-cancel">Cancel</button>
            <button class="ft-btn ft-btn-primary ft-settings-save">Save</button>
          </div>
        </div>
      </div>
    `;

    // Event listeners
    overlay.querySelector('.ft-settings-close').addEventListener('click', closeSettings);
    overlay.querySelector('.ft-settings-cancel').addEventListener('click', closeSettings);
    overlay.querySelector('.ft-settings-save').addEventListener('click', saveSettings);
    overlay.querySelector('.ft-settings-reset-all').addEventListener('click', resetAllSettings);
    overlay.querySelector('#ft-reset-position').addEventListener('click', resetButtonPosition);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) closeSettings();
    });

    // Per-field reset buttons
    overlay.querySelectorAll('.ft-settings-reset-btn').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const field = e.target.closest('.ft-settings-field');
        if (field) {
          const fieldName = field.dataset.field;
          resetField(fieldName);
        }
      });
    });

    // Color selection
    overlay.querySelectorAll('.ft-settings-color').forEach(swatch => {
      swatch.addEventListener('click', () => {
        overlay.querySelectorAll('.ft-settings-color').forEach(s => s.classList.remove('ft-selected'));
        swatch.classList.add('ft-selected');
      });
    });

    // Icon selection
    overlay.querySelectorAll('.ft-settings-icon').forEach(iconEl => {
      iconEl.addEventListener('click', () => {
        overlay.querySelectorAll('.ft-settings-icon').forEach(i => i.classList.remove('ft-selected'));
        iconEl.classList.add('ft-selected');
      });
    });

    // Opacity slider value display
    const opacitySlider = overlay.querySelector('#ft-settings-opacity');
    const opacityValue = overlay.querySelector('#ft-settings-opacity-value');
    opacitySlider.addEventListener('input', () => {
      opacityValue.textContent = opacitySlider.value;
    });

    document.body.appendChild(overlay);
    return overlay;
  }

  function openSettings() {
    if (!settingsModal) {
      settingsModal = createSettingsModal();
    }
    populateSettingsForm();
    settingsModal.classList.add('ft-visible');
  }

  function closeSettings() {
    if (settingsModal) {
      settingsModal.classList.remove('ft-visible');
    }
  }

  function populateSettingsForm() {
    const cookieSettings = getSettingsCookie();

    // Helper to set field value and mark if overridden
    const setField = (fieldName, value) => {
      const field = settingsModal.querySelector(`[data-field="${fieldName}"]`);
      const input = settingsModal.querySelector(`#ft-settings-${fieldName}`);
      const hint = field?.querySelector('.ft-settings-override-hint');
      const resetBtn = field?.querySelector('.ft-settings-reset-btn');

      if (!input) return;

      // Set value
      if (input.type === 'checkbox') {
        input.checked = value;
      } else if (input.tagName === 'SELECT' || input.type === 'text' || input.type === 'password' || input.type === 'number' || input.type === 'range') {
        input.value = value;
        if (input.type === 'range') {
          settingsModal.querySelector('#ft-settings-opacity-value').textContent = value;
        }
      }

      // Check if overridden
      const isOverridden = fieldName in cookieSettings && cookieSettings[fieldName] !== codeDefaults[fieldName];
      if (field) {
        field.classList.toggle('ft-overridden', isOverridden);
      }
      if (hint) {
        if (isOverridden) {
          const defaultVal = codeDefaults[fieldName];
          const displayVal = Array.isArray(defaultVal) ? defaultVal.join(', ') : (defaultVal || '(empty)');
          hint.textContent = `Overrides code default: ${displayVal}`;
        } else {
          hint.textContent = '';
        }
      }
      if (resetBtn) {
        resetBtn.style.visibility = isOverridden ? 'visible' : 'hidden';
      }
    };

    // Set simple fields
    setField('testerId', config.testerId);
    setField('defaultTitle', config.defaultTitle);
    setField('size', config.size);
    setField('shape', config.shape);
    setField('opacity', config.opacity);
    setField('pulse', config.pulse);
    setField('title', config.title);
    setField('categories', Array.isArray(config.categories) ? config.categories.join(', ') : config.categories);
    setField('endpoint', config.endpoint);
    setField('apiKey', config.apiKey);
    setField('apiSecret', config.apiSecret);
    setField('vars', Array.isArray(config.vars) ? config.vars.join(', ') : config.vars);
    setField('demoMode', config.demoMode);

    // Set color
    const colorField = settingsModal.querySelector('[data-field="color"]');
    settingsModal.querySelectorAll('.ft-settings-color').forEach(swatch => {
      swatch.classList.toggle('ft-selected', swatch.dataset.value === config.color);
    });
    const colorOverridden = 'color' in cookieSettings && cookieSettings.color !== codeDefaults.color;
    if (colorField) {
      const hint = colorField.querySelector('.ft-settings-override-hint');
      if (hint) {
        hint.textContent = colorOverridden ? `Overrides code default: ${codeDefaults.color}` : '';
      }
    }

    // Set icon
    const iconField = settingsModal.querySelector('[data-field="icon"]');
    settingsModal.querySelectorAll('.ft-settings-icon').forEach(iconEl => {
      iconEl.classList.toggle('ft-selected', iconEl.dataset.value === config.icon);
    });
    const iconOverridden = 'icon' in cookieSettings && cookieSettings.icon !== codeDefaults.icon;
    if (iconField) {
      const hint = iconField.querySelector('.ft-settings-override-hint');
      if (hint) {
        hint.textContent = iconOverridden ? `Overrides code default: ${codeDefaults.icon}` : '';
      }
    }
  }

  function saveSettings() {
    const newSettings = {};

    // Collect values
    newSettings.testerId = settingsModal.querySelector('#ft-settings-testerId').value.trim();
    newSettings.defaultTitle = settingsModal.querySelector('#ft-settings-defaultTitle').value.trim();
    newSettings.size = settingsModal.querySelector('#ft-settings-size').value;
    newSettings.shape = settingsModal.querySelector('#ft-settings-shape').value;
    newSettings.opacity = parseFloat(settingsModal.querySelector('#ft-settings-opacity').value) || 1;
    newSettings.pulse = settingsModal.querySelector('#ft-settings-pulse').checked;
    newSettings.demoMode = settingsModal.querySelector('#ft-settings-demoMode').checked;
    newSettings.title = settingsModal.querySelector('#ft-settings-title').value.trim() || 'Send Feedback';
    newSettings.endpoint = settingsModal.querySelector('#ft-settings-endpoint').value.trim();
    newSettings.apiKey = settingsModal.querySelector('#ft-settings-apiKey').value.trim();
    newSettings.apiSecret = settingsModal.querySelector('#ft-settings-apiSecret').value.trim();

    // Categories
    const categoriesStr = settingsModal.querySelector('#ft-settings-categories').value.trim();
    newSettings.categories = categoriesStr ? categoriesStr.split(',').map(c => c.trim()).filter(Boolean).slice(0, 10) : codeDefaults.categories;

    // Vars
    const varsStr = settingsModal.querySelector('#ft-settings-vars').value.trim();
    newSettings.vars = varsStr ? varsStr.split(',').map(v => v.trim()).filter(Boolean) : [];

    // Color
    const selectedColor = settingsModal.querySelector('.ft-settings-color.ft-selected');
    newSettings.color = selectedColor ? selectedColor.dataset.value : codeDefaults.color;

    // Icon
    const selectedIcon = settingsModal.querySelector('.ft-settings-icon.ft-selected');
    newSettings.icon = selectedIcon ? selectedIcon.dataset.value : codeDefaults.icon;

    // Save to cookie (only values that differ from code defaults, or all if user wants persistence)
    setSettingsCookie(newSettings);

    // Apply to config
    Object.assign(config, newSettings);

    // Rebuild UI
    rebuildUI();

    closeSettings();
    showToast('Settings saved', 'success');
  }

  function resetField(fieldName) {
    const cookieSettings = getSettingsCookie();
    delete cookieSettings[fieldName];
    setSettingsCookie(cookieSettings);

    // Restore code default
    config[fieldName] = codeDefaults[fieldName];

    // Re-populate form
    populateSettingsForm();

    // Rebuild UI if it's a visual setting
    if (['position', 'color', 'size', 'shape', 'offset', 'opacity', 'pulse', 'icon'].includes(fieldName)) {
      rebuildUI();
    }
  }

  function resetAllSettings() {
    if (!confirm('Reset all settings to code defaults?')) return;

    clearSettingsCookie();

    // Restore all code defaults
    Object.assign(config, codeDefaults);

    // Re-populate form
    populateSettingsForm();

    // Rebuild UI
    rebuildUI();

    showToast('All settings reset', 'success');
  }

  function rebuildUI() {
    // Remove old elements
    if (floatingButton) floatingButton.remove();
    if (fanMenu) fanMenu.remove();
    if (modal) modal.remove();

    // Recreate with new config
    floatingButton = createFloatingButton();
    fanMenu = createFanMenu();
    modal = createModal();
  }

  // ============ END SETTINGS MODAL ============

  // Initialize
  function init() {
    injectStyles();
    floatingButton = createFloatingButton();
    fanMenu = createFanMenu();
    modal = createModal();

    // Re-check button position on window resize
    window.addEventListener('resize', () => {
      if (!floatingButton) return;

      const rect = floatingButton.getBoundingClientRect();
      const size = getButtonSize();

      // Clamp to new viewport bounds
      let x = Math.min(rect.left, window.innerWidth - size);
      let y = Math.min(rect.top, window.innerHeight - size);
      x = Math.max(0, x);
      y = Math.max(0, y);

      // Only update if position changed
      if (x !== rect.left || y !== rect.top) {
        floatingButton.style.left = x + 'px';
        floatingButton.style.top = y + 'px';

        // Save new position
        config.offset = createOffset(x, y);
        const settings = getSettingsCookie();
        settings.offset = config.offset;
        setSettingsCookie(settings);
      }
    });

    // Preload html2canvas
    loadHtml2Canvas().catch(() => {});

    console.log('Ginotate initialized');
  }

  // Wait for DOM
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
