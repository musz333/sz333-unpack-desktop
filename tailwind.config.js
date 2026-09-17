/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./src/renderer/index.html', './src/renderer/src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // 中性灰阶：全部层级由此建立
        ink: {
          0: 'rgb(var(--c-surface) / <alpha-value>)',
          1: 'rgb(var(--c-surface-2) / <alpha-value>)',
          2: 'rgb(var(--c-surface-3) / <alpha-value>)'
        },
        line: {
          DEFAULT: 'rgb(var(--c-border) / <alpha-value>)',
          strong: 'rgb(var(--c-border-strong) / <alpha-value>)'
        },
        fg: {
          DEFAULT: 'rgb(var(--c-text) / <alpha-value>)',
          muted: 'rgb(var(--c-text-2) / <alpha-value>)',
          faint: 'rgb(var(--c-text-3) / <alpha-value>)'
        },
        // 唯一强调色（品牌青绿）
        brand: {
          DEFAULT: 'rgb(var(--c-accent) / <alpha-value>)',
          hover: 'rgb(var(--c-accent-hover) / <alpha-value>)',
          soft: 'rgb(var(--c-accent-soft) / <alpha-value>)',
          line: 'rgb(var(--c-accent-border) / <alpha-value>)'
        },
        // 语义色：仅成功 / 警告 / 错误
        ok: { DEFAULT: 'rgb(var(--c-ok) / <alpha-value>)', soft: 'rgb(var(--c-ok-soft) / <alpha-value>)' },
        warn: { DEFAULT: 'rgb(var(--c-warn) / <alpha-value>)', soft: 'rgb(var(--c-warn-soft) / <alpha-value>)' },
        bad: { DEFAULT: 'rgb(var(--c-bad) / <alpha-value>)', soft: 'rgb(var(--c-bad-soft) / <alpha-value>)' }
      },
      fontFamily: {
        sans: ['Inter', 'ui-sans-serif', 'system-ui', 'Segoe UI', 'Noto Sans SC', 'Microsoft YaHei UI', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace']
      },
      // 字号严格按 12 / 14 / 16 / 20 / 28
      fontSize: {
        xs: ['12px', '18px'],
        sm: ['14px', '20px'],
        base: ['16px', '24px'],
        lg: ['20px', '28px'],
        xl: ['28px', '36px']
      },
      // 8pt 间距系统
      spacing: {
        1: '4px',
        2: '8px',
        3: '12px',
        4: '16px',
        5: '20px',
        6: '24px',
        8: '32px',
        10: '40px',
        12: '48px'
      },
      borderRadius: {
        btn: '8px',
        card: '10px',
        panel: '12px'
      },
      boxShadow: {
        // 仅浮层 / 下拉 / Toast 使用，且极淡
        pop: '0 6px 16px rgb(0 0 0 / 0.06), 0 2px 4px rgb(0 0 0 / 0.04)',
        toast: '0 10px 30px rgb(0 0 0 / 0.10)'
      },
      transitionTimingFunction: {
        out: 'cubic-bezier(0.22, 0.61, 0.36, 1)'
      },
      transitionDuration: {
        fast: '150ms',
        base: '180ms',
        slow: '240ms'
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'none' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        shake: { '10%,90%': { transform: 'translateX(-1px)' }, '20%,80%': { transform: 'translateX(2px)' }, '30%,50%,70%': { transform: 'translateX(-3px)' }, '40%,60%': { transform: 'translateX(3px)' } }
      },
      animation: {
        'fade-up': 'fade-up 180ms cubic-bezier(0.22,0.61,0.36,1) both',
        'fade-in': 'fade-in 150ms ease-out both',
        shake: 'shake 320ms ease-out'
      }
    }
  },
  plugins: []
};
