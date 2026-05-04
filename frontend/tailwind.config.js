/** @type {import('tailwindcss').Config} */
export default {
  content: [
    './index.html',
    './src/**/*.{js,ts,jsx,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        steel: {
          50: '#f7f9fa',
          100: '#e3e8ec',
          200: '#c7d0d8',
          300: '#a3b2bf',
          400: '#7a8f9f',
          500: '#627d98',
          600: '#4a6178',
          700: '#334e68',
          800: '#1a3347',
          900: '#0f2333',
          950: '#09121a',
        },
      },
      fontFamily: {
        sans: ['Inter', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'Monaco', 'Consolas', 'monospace'],
        display: ['Inter', 'system-ui', 'sans-serif'],
      },
      animation: {
        'slide-in': 'slideIn 0.3s ease-out',
        'fade-in': 'fadeIn 0.4s ease-out',
        'slide-up': 'slideUp 0.2s ease-out',
      },
      keyframes: {
        slideIn: {
          '0%': { opacity: '0', transform: 'translateY(-8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          '0%': { opacity: '0' },
          '100%': { opacity: '1' },
        },
        slideUp: {
          '0%': { transform: 'translateY(100%)', opacity: '0' },
          '100%': { transform: 'translateY(0)', opacity: '1' },
        },
      },
    },
  },
  plugins: [
    function ({ addComponents }) {
      addComponents({
        '.btn-secondary': {
          display: 'inline-flex',
          alignItems: 'center',
          padding: '0.375rem 0.75rem',
          borderRadius: '0.5rem',
          backgroundColor: '#1a3347',
          color: '#c7d0d8',
          fontSize: '0.75rem',
          fontWeight: '500',
          border: '1px solid #334e68',
          transition: 'all 150ms',
          '&:hover': {
            backgroundColor: '#334e68',
            borderColor: '#4a6178',
          },
          '&:disabled': {
            opacity: '0.5',
            cursor: 'not-allowed',
          },
        },
      })
    },
  ],
}