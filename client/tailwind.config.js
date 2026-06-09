/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        slate: {
          450: '#8494a7',
        },
        indigo: {
          650: '#4338ca',
        },
        emerald: {
          55: '#ecfdf5',
        },
      },
    },
  },
  plugins: [],
}

