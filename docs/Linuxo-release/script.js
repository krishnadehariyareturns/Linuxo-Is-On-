// Linuxo Release Invitation — Anime.js motion layer
const launch = new Date("2026-09-15T19:00:00+05:30").getTime();

const pad = n => String(Math.max(0, Math.floor(n))).padStart(2, "0");

function tick() {
  const diff = launch - Date.now();
  const total = Math.max(0, diff);
  document.querySelector("#days").textContent = pad(total / 86400000);
  document.querySelector("#hours").textContent = pad((total / 3600000) % 24);
  document.querySelector("#minutes").textContent = pad((total / 60000) % 60);
  document.querySelector("#seconds").textContent = pad((total / 1000) % 60);
}
tick();
setInterval(tick, 1000);

// Hero entrance
anime.timeline({ easing: "easeOutExpo" })
  .add({ targets: ".eyebrow", opacity:[0,1], translateY:[25,0], duration:900 })
  .add({ targets: ".hero-title span", opacity:[0,1], translateY:["110%","0%"], duration:1300, delay:anime.stagger(140) }, "-=600")
  .add({ targets: ".hero-copy, .launch-meta, .launch-link", opacity:[0,1], translateY:[30,0], duration:900, delay:anime.stagger(100) }, "-=850")
  .add({ targets: ".scroll-note", opacity:[0,1], duration:700 }, "-=400");

const revealObserver = new IntersectionObserver(entries => {
  entries.forEach(entry => {
    if (!entry.isIntersecting) return;
    entry.target.classList.add("seen");
    anime({
      targets: entry.target,
      opacity:[0,1],
      translateY:[50,0],
      duration:1100,
      easing:"easeOutExpo"
    });
    revealObserver.unobserve(entry.target);
  });
}, { threshold:.14 });

document.querySelectorAll(".section > *, .feature-card").forEach(el => {
  el.style.opacity = "0";
  revealObserver.observe(el);
});

// Feature hover motion
document.querySelectorAll(".feature-card").forEach(card => {
  card.addEventListener("mousemove", e => {
    const r = card.getBoundingClientRect();
    const x = (e.clientX-r.left)/r.width-.5;
    const y = (e.clientY-r.top)/r.height-.5;
    anime.remove(card);
    anime({
      targets:card,
      rotateX:-y*3,
      rotateY:x*3,
      duration:300,
      easing:"easeOutQuad"
    });
  });
  card.addEventListener("mouseleave", () => anime({
    targets:card, rotateX:0, rotateY:0, duration:700, easing:"easeOutElastic(1,.5)"
  }));
});

// Magnetic launch links
document.querySelectorAll(".magnetic").forEach(el => {
  el.addEventListener("mousemove", e => {
    const r=el.getBoundingClientRect();
    anime({targets:el, translateX:(e.clientX-r.left-r.width/2)*.12, translateY:(e.clientY-r.top-r.height/2)*.12, duration:400, easing:"easeOutQuad"});
  });
  el.addEventListener("mouseleave", () => anime({targets:el, translateX:0, translateY:0, duration:800, easing:"easeOutElastic(1,.45)"}));
});

// Custom cursor glow
const glow = document.querySelector(".cursor-glow");
window.addEventListener("pointermove", e => {
  anime({targets:glow, left:e.clientX, top:e.clientY, duration:500, easing:"easeOutQuad"});
});

// Terminal reveal
const lines = [
  "$ linuxo --boot",
  "[ 19:00:00 ] <span class='bright'>initializing Linuxo...</span>",
  "[ 19:00:00 ] loading command registry",
  "[ 19:00:01 ] initializing structured logger",
  "[ 19:00:01 ] registering /startup",
  "[ 19:00:02 ] diagnostics: ready",
  "[ 19:00:02 ] <span class='bright'>Linuxo is ready.</span>",
  "",
  "$ echo 'see you on 15 September.'"
];
const terminal = document.querySelector("#terminalBody");
lines.forEach((line,i) => {
  const div=document.createElement("div");
  div.className="term-line";
  div.innerHTML=line || "&nbsp;";
  terminal.appendChild(div);
});
const terminalObserver = new IntersectionObserver(entries => {
  if (!entries[0].isIntersecting) return;
  anime({
    targets: ".term-line",
    opacity:[0,1],
    translateX:[-15,0],
    duration:500,
    delay:anime.stagger(170),
    easing:"easeOutQuad"
  });
  terminalObserver.disconnect();
}, {threshold:.35});
terminalObserver.observe(document.querySelector(".terminal-window"));

// Subtle scroll parallax
window.addEventListener("scroll", () => {
  const title=document.querySelector(".hero-title");
  if (window.scrollY < innerHeight) {
    title.style.transform=`translateY(${window.scrollY*.08}px)`;
  }
});
