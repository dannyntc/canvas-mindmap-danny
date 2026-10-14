export interface PastelColor {
	id: string;
	label: string;
	hex: string;
}

/** Fixed, readable pastel colours stored directly in Canvas JSON. */
export const PASTEL_COLORS: readonly PastelColor[] = [
	{ id: "rose", label: "Rose", hex: "#F4B6C2" },
	{ id: "peach", label: "Peach", hex: "#F7C59F" },
	{ id: "butter", label: "Butter", hex: "#F5E6A8" },
	{ id: "mint", label: "Mint", hex: "#B8E0C2" },
	{ id: "sky", label: "Sky", hex: "#B9D7EA" },
	{ id: "periwinkle", label: "Periwinkle", hex: "#C7C5F2" },
	{ id: "lavender", label: "Lavender", hex: "#DCC6E0" },
	{ id: "sage", label: "Sage", hex: "#C8D5B9" },
];
