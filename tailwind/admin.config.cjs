// Tema de Tailwind de esta app (antes estaba dentro de cada página, para el CDN).
// Después de cambiarlo, o de agregar clases nuevas en el HTML o el JS: npm run css
const tema = {
      theme: {
        extend: {
          fontFamily: {
            sans: ['"Plus Jakarta Sans"', 'sans-serif'],
          },
          colors: {
            brand: {
              black: '#0A0A0C',
              dark: '#121217',
              card: '#18181F',
              accent: '#E63946',
              accentHover: '#D62839',
              gold: '#F4A261',
              muted: '#71717A',
              border: '#27272A'
            }
          }
        }
      }
    };

module.exports = { content: ["./index.html", "./Templates/*.html", "./scripts/*.js"], ...tema };
