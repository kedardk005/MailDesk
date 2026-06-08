export const initCursorEffects = () => {
  if (typeof window === 'undefined') return;
  
  // Create and inject custom cursor elements
  const dot = document.createElement('div');
  const ring = document.createElement('div');
  dot.className = 'custom-cursor-dot';
  ring.className = 'custom-cursor-ring';
  document.body.appendChild(dot);
  document.body.appendChild(ring);

  let mouseX = 0;
  let mouseY = 0;
  let ringX = 0;
  let ringY = 0;
  let isHovering = false;

  // Track absolute cursor position
  document.addEventListener('mousemove', (e) => {
    mouseX = e.clientX;
    mouseY = e.clientY;
    
    // Position dot immediately
    dot.style.transform = `translate3d(${mouseX - 5}px, ${mouseY - 5}px, 0) scale(${isHovering ? 1.4 : 1})`;
    dot.style.opacity = '1';
  });

  // Smooth trail animation using linear interpolation (lerp)
  function animate() {
    const speed = 0.15;
    ringX += (mouseX - ringX) * speed;
    ringY += (mouseY - ringY) * speed;
    
    ring.style.transform = `translate3d(${ringX - 15}px, ${ringY - 15}px, 0) scale(${isHovering ? 1.4 : 1})`;
    ring.style.opacity = '1';
    
    requestAnimationFrame(animate);
  }
  animate();

  // Hide custom cursor elements when cursor leaves viewport
  document.addEventListener('mouseleave', () => {
    dot.style.opacity = '0';
    ring.style.opacity = '0';
  });
  
  document.addEventListener('mouseenter', () => {
    dot.style.opacity = '1';
    ring.style.opacity = '1';
  });

  // Expand cursor styling on hover of interactive nodes
  const hoverables = 'a, button, input, select, textarea, [role="button"], .cursor-pointer, input[type="checkbox"]';
  document.addEventListener('mouseover', (e) => {
    if (e.target.closest(hoverables)) {
      isHovering = true;
      ring.style.borderColor = '#6366F1';
      ring.style.opacity = '0.5';
    }
  });
  
  document.addEventListener('mouseout', (e) => {
    if (e.target.closest(hoverables)) {
      isHovering = false;
      ring.style.borderColor = '#8B5CF6';
      ring.style.opacity = '0.3';
    }
  });

  // Add magnetic translate transition on all buttons
  document.addEventListener('mousemove', (e) => {
    const button = e.target.closest('button, .magnetic-btn');
    if (button) {
      const rect = button.getBoundingClientRect();
      const x = e.clientX - rect.left - rect.width / 2;
      const y = e.clientY - rect.top - rect.height / 2;
      
      const strength = 0.25;
      button.style.transform = `translate3d(${x * strength}px, ${y * strength}px, 0)`;
      button.style.transition = 'transform 0.08s ease-out';
    }
  });
  
  document.addEventListener('mouseout', (e) => {
    const button = e.target.closest('button, .magnetic-btn');
    if (button) {
      const toElement = e.relatedTarget;
      if (!toElement || !button.contains(toElement)) {
        button.style.transform = '';
        button.style.transition = 'transform 0.3s cubic-bezier(0.25, 1, 0.5, 1)';
      }
    }
  });

  // Trigger ripple span expanding inside target button click locations
  document.addEventListener('click', (e) => {
    const button = e.target.closest('button, .ripple-btn');
    if (button) {
      const rect = button.getBoundingClientRect();
      const ripple = document.createElement('span');
      const size = Math.max(rect.width, rect.height);
      const x = e.clientX - rect.left - size / 2;
      const y = e.clientY - rect.top - size / 2;
      
      ripple.className = 'btn-ripple-span';
      ripple.style.width = ripple.style.height = `${size}px`;
      ripple.style.left = `${x}px`;
      ripple.style.top = `${y}px`;
      
      const originalPosition = window.getComputedStyle(button).position;
      if (originalPosition === 'static') {
        button.style.position = 'relative';
      }
      button.style.overflow = 'hidden';
      
      button.appendChild(ripple);
      
      setTimeout(() => {
        ripple.remove();
      }, 600);
    }
  });
};
