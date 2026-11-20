import type { Trade } from "../enums";

/*
  Suggested services per trade (Jason, 26 September 2026): one-click chips
  in the intake's Services section, from this built-in list. No AI. Only a
  suggestion: the PM adds what the client actually offers.
*/
export const SERVICE_SUGGESTIONS: Record<Trade, string[]> = {
  plumbing: ["Drain cleaning", "Water heater repair and installation", "Leak detection and repair", "Sewer line repair", "Toilet and faucet repair", "Repiping", "Garbage disposal installation"],
  hvac: ["AC repair", "Furnace repair", "AC installation", "Heat pump service", "Maintenance plans", "Ductless mini-splits", "Indoor air quality"],
  electrical: ["Panel upgrades", "Lighting installation", "EV charger installation", "Outlet and switch repair", "Whole-home rewiring", "Generator installation", "Electrical inspections"],
  roofing: ["Roof repair", "Roof replacement", "Roof inspections", "Storm damage repair", "Gutter installation", "Leak repair", "Commercial roofing"],
  legal: ["Personal injury", "Family law", "Estate planning", "Criminal defense", "Business law", "Real estate law", "Immigration"],
  glass_and_windows: ["Window replacement", "Shower doors", "Glass repair", "Storefront glass", "Mirrors", "Window screens", "Emergency board-up"],
  garage_doors: ["Garage door repair", "Spring replacement", "Opener installation", "New garage doors", "Cable and roller repair", "Commercial doors", "Maintenance and tune-ups"],
  well_and_pump: ["Well pump repair", "Well drilling", "Pressure tank replacement", "Water testing", "Water treatment and filtration", "Well inspections", "Pump replacement"],
  pest_control: ["General pest control", "Termite inspection and treatment", "Rodent control", "Bed bug treatment", "Mosquito control", "Ant and spider control", "Wildlife exclusion"],
  home_services: ["Handyman repairs", "Drywall repair", "Painting", "Flooring installation", "Fixture installation", "Carpentry", "Home maintenance"],
  med_spa: ["Botox and fillers", "Laser hair removal", "Facials", "Microneedling", "Chemical peels", "Body contouring", "Skin consultations"],
  interior_design: ["Full-home interior design", "Kitchen and bath design", "Space planning", "Furniture and decor selection", "Color consultations", "Home staging", "Commercial interiors"],
  art_decorative_finishes: ["Murals", "Decorative plaster", "Faux finishes", "Venetian plaster", "Cabinet refinishing", "Gilding", "Commissioned artwork"],
  photography: ["Wedding photography", "Portrait sessions", "Family photos", "Real estate photography", "Commercial and product photography", "Headshots", "Event photography"],
  architecture_remodeling: ["Kitchen remodeling", "Bathroom remodeling", "Home additions", "Whole-home renovations", "Architectural design", "Permit drawings", "Custom homes"],
  other: [],
};

/* The first few suggestions the business doesn't already list (compared loosely). */
export function suggestedServices(trade: Trade, existing: string[], count = 5): string[] {
  const have = new Set(existing.map((name) => name.trim().toLowerCase()));
  return SERVICE_SUGGESTIONS[trade].filter((name) => !have.has(name.toLowerCase())).slice(0, count);
}
