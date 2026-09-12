import { unit } from "mathjs";
import { formatNumber, validateMeasurement } from "./convert";

// Defined physical representation shared by production routing and evaluations.
export const printedDataSources = {
  encoding: "https://www.rfc-editor.org/rfc/rfc4648#section-8",
  paper: "https://hp-papers.eu/wp-content/uploads/2024/01/HP-Copy-Product-Data-Sheet-EN-301023.pdf",
  earth: "https://science.nasa.gov/earth/facts/"
} as const;

export function printedDataComparison(quantity: number, sourceUnit: string) {
  const measurement = validateMeasurement(quantity, sourceUnit);
  if (measurement.dimension !== "data") return undefined;
  const bytes = unit(measurement.quantity, measurement.sourceUnit).toNumber("B");
  // Print whole bytes only. Larger magnitudes need a decimal/BigInt input path
  // before we can make exact claims about the final sheet.
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > Number.MAX_SAFE_INTEGER - 1999) return undefined;
  const hexCharactersPerByte = 2;
  const hexCharactersPerPage = 2000; // Defined layout, excluding line breaks.
  const pagesPerSheet = 2;
  const bytesPerSheet = hexCharactersPerPage * pagesPerSheet / hexCharactersPerByte;
  const sheets = Math.ceil(bytes / bytesPerSheet);
  const thicknessMetres = 106e-6;
  const thicknessToleranceMetres = 3e-6;
  const earthDiameterMetres = 12756000;
  const nominalStackMetres = sheets * thicknessMetres;
  const earthDiameters = nominalStackMetres / earthDiameterMetres;
  return {
    quantity: measurement.quantity,
    sourceUnit: measurement.sourceUnit,
    representation: "base16-duplex-printout" as const,
    operands: { bytes, hexCharactersPerByte, hexCharactersPerPage, pagesPerSheet, bytesPerSheet, sheets, thicknessMetres, thicknessToleranceMetres, earthDiameterMetres },
    computed: {
      nominalStackMetres,
      earthDiameters,
      earthDiametersAtPaperSpecificationLimits: [
        sheets * (thicknessMetres - thicknessToleranceMetres) / earthDiameterMetres,
        sheets * (thicknessMetres + thicknessToleranceMetres) / earthDiameterMetres
      ],
      unusedByteCapacity: sheets * bytesPerSheet - bytes
    },
    // Reject unreadable Earth comparisons rather than retuning the page layout.
    headline: earthDiameters >= 0.1 && earthDiameters <= 100
      ? `Print it double-sided: a paper stack about ${formatNumber(Number(earthDiameters.toPrecision(2)))} Earths tall.`
      : undefined,
    basis: "Represent each byte as two hexadecimal characters. Use 2,000 hex characters per page and print both sides; round the last sheet up. Use HP Copy 80 gsm paper's nominal 106-micrometre thickness (specified ±3) and Earth's 12,756-kilometre equatorial diameter. Add the uncompressed sheet thicknesses; ignore toner, gaps, covers and bindings. This is an imagined stack, not a physically stable tower. The layout is a chosen assumption, not an average book page.",
    sources: printedDataSources
  };
}
