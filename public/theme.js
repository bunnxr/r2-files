// Runs in <head> before the page paints, so the saved theme shows without a flash.
// "light" (default) or "dark" (OLED black), chosen in Settings (the gear) and kept in this browser.
(function(){var d=document.documentElement,t='light';try{t=localStorage.getItem('fm-theme')==='dark'?'dark':'light'}catch(e){}d.dataset.theme=t;var m=document.querySelector('meta[name=theme-color]');if(m)m.content=t==='dark'?'#000000':'#fbf8f3'})();
