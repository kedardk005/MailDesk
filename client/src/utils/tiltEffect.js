export function initTilt(element, maxDeg = 6, perspective = 800) {
  if (!element) return () => {};

  // Ensure element has transition and transform-style properties
  element.style.transition = 'transform 0.15s ease-out, box-shadow 0.15s ease-out';
  element.style.transformStyle = 'preserve-3d';

  // Add glare overlay dynamically if it doesn't exist
  let glare = element.querySelector('.tilt-glare');
  if (!glare) {
    glare = document.createElement('div');
    glare.className = 'tilt-glare';
    glare.style.position = 'absolute';
    glare.style.inset = '0';
    glare.style.pointerEvents = 'none';
    glare.style.borderRadius = window.getComputedStyle(element).borderRadius || '24px';
    glare.style.background = 'radial-gradient(circle at 50% 50%, rgba(255,255,255,0.15) 0%, rgba(255,255,255,0) 80%)';
    glare.style.opacity = '0';
    glare.style.transition = 'opacity 0.2s ease-out';
    glare.style.zIndex = '10';
    
    // Ensure element has relative positioning
    if (window.getComputedStyle(element).position === 'static') {
      element.style.position = 'relative';
    }
    // Set overflow hidden on element to contain glare if card has border radius
    element.style.overflow = 'hidden';
    
    element.appendChild(glare);
  }

  // Handle mousemove
  const onMouseMove = (e) => {
    const rect = element.getBoundingClientRect();
    const width = rect.width;
    const height = rect.height;
    
    // Position of cursor relative to element center
    const x = e.clientX - rect.left - width / 2;
    const y = e.clientY - rect.top - height / 2;

    // Calculate rotation degree (-1 to 1 range, multiplied by maxDeg)
    const rotateX = -((y / (height / 2)) * maxDeg);
    const rotateY = (x / (width / 2)) * maxDeg;

    // Glare position
    const glareX = ((e.clientX - rect.left) / width) * 100;
    const glareY = ((e.clientY - rect.top) / height) * 100;
    glare.style.background = `radial-gradient(circle at ${glareX}% ${glareY}%, rgba(255,255,255,0.2) 0%, rgba(255,255,255,0) 70%)`;
    glare.style.opacity = '0.4';

    // Apply transform
    element.style.transform = `perspective(${perspective}px) rotateX(${rotateX}deg) rotateY(${rotateY}deg)`;
    element.style.transition = 'transform 0.05s ease-out'; // Snappy follow

    // Apply opposite translation to inner parallax elements if any
    const parallaxEl = element.querySelector('.tilt-parallax');
    if (parallaxEl) {
      const paraX = -(x / (width / 2)) * 6;
      const paraY = -(y / (height / 2)) * 6;
      parallaxEl.style.transform = `translate3d(${paraX}px, ${paraY}px, 20px)`;
      parallaxEl.style.transition = 'transform 0.05s ease-out';
    }
  };

  // Handle mouseleave
  const onMouseLeave = () => {
    element.style.transition = 'transform 0.6s cubic-bezier(0.23, 1, 0.32, 1), box-shadow 0.6s cubic-bezier(0.23, 1, 0.32, 1)';
    element.style.transform = `perspective(${perspective}px) rotateX(0deg) rotateY(0deg)`;
    glare.style.opacity = '0';

    const parallaxEl = element.querySelector('.tilt-parallax');
    if (parallaxEl) {
      parallaxEl.style.transition = 'transform 0.6s cubic-bezier(0.23, 1, 0.32, 1)';
      parallaxEl.style.transform = 'translate3d(0px, 0px, 0px)';
    }
  };

  element.addEventListener('mousemove', onMouseMove);
  element.addEventListener('mouseleave', onMouseLeave);

  // Return cleanup
  return () => {
    element.removeEventListener('mousemove', onMouseMove);
    element.removeEventListener('mouseleave', onMouseLeave);
    if (glare) glare.remove();
  };
}

// Auto-initialize tilt on components matching a selector
export function autoTilt(selector, maxDeg = 6, perspective = 800) {
  if (typeof document === 'undefined') return () => {};
  
  const cleanups = [];
  const initialize = () => {
    const els = document.querySelectorAll(selector);
    els.forEach(el => {
      // Check if already initialized by looking for a marker class or property
      if (el.dataset.tiltInitialized) return;
      el.dataset.tiltInitialized = 'true';
      const cleanup = initTilt(el, maxDeg, perspective);
      cleanups.push(cleanup);
    });
  };

  // Run initial init
  setTimeout(initialize, 100);

  // Return cleanup for all
  return () => {
    cleanups.forEach(c => c());
  };
}
