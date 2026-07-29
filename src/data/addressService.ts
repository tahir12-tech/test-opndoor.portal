// /* =====================================================================
//    UK address lookup (postcode-first entry).

//    INTEGRATION: wired to getaddress.io. Set VITE_ADDRESS_LOOKUP_KEY to enable.
//    To use Ideal Postcodes or another provider instead, swap the request URL and
//    the response mapping below; the rest of the app only depends on this
//    module's shape.

//    Degrades gracefully: with no key configured, addressLookupAvailable() is
//    false and the form uses manual address entry. A failed request returns an
//    error message but never breaks the form.
//    ===================================================================== */
// const KEY = import.meta.env.VITE_ADDRESS_LOOKUP_KEY;

// export interface AddressOption {
//   line1: string;
//   line2: string;
//   city: string;
//   county: string;
//   postcode: string;
//   /** Human-readable single-line summary for the dropdown. */
//   label: string;
// }

// export interface AddressLookupResult {
//   /** False when no provider key is configured (fall back to manual entry). */
//   available: boolean;
//   addresses: AddressOption[];
//   error?: string;
// }

// /** True when a lookup provider is configured. */
// export function addressLookupAvailable(): boolean {
//   return Boolean(KEY);
// }

// /** Look up addresses at a postcode. Never throws. */
// export async function lookupAddresses(postcodeRaw: string): Promise<AddressLookupResult> {
//   if (!KEY) return { available: false, addresses: [] };
//   const postcode = (postcodeRaw || '').trim();
//   if (!postcode) return { available: true, addresses: [] };

//   try {
//     const url = `https://api.getaddress.io/find/${encodeURIComponent(postcode)}?api-key=${encodeURIComponent(KEY)}&expand=true`;
//     const res = await fetch(url);
//     if (!res.ok) {
//       return {
//         available: true,
//         addresses: [],
//         error: res.status === 404 ? 'No addresses found for that postcode.' : 'Address lookup is unavailable right now. Enter the address manually.',
//       };
//     }
//     // eslint-disable-next-line @typescript-eslint/no-explicit-any
//     const data: any = await res.json();
//     const pc = String(data.postcode || postcode).toUpperCase();
//     // eslint-disable-next-line @typescript-eslint/no-explicit-any
//     const addresses: AddressOption[] = (data.addresses || []).map((a: any) => {
//       const line1 = a.line_1 || '';
//       const line2 = [a.line_2, a.line_3, a.line_4].filter(Boolean).join(', ');
//       const city = a.town_or_city || a.locality || '';
//       const county = a.county || '';
//       return { line1, line2, city, county, postcode: pc, label: [line1, line2, city].filter(Boolean).join(', ') };
//     });
//     return { available: true, addresses };
//   } catch {
//     return { available: true, addresses: [], error: 'Address lookup is unavailable right now. Enter the address manually.' };
//   }
// }


/* =====================================================================
   UK address lookup (postcode-first entry).

   INTEGRATION: wired to Ideal Postcodes. Set VITE_ADDRESS_LOOKUP_KEY to enable.
   To use a different provider instead, swap the request URL and the response
   mapping below; the rest of the app only depends on this module's shape.

   Degrades gracefully: with no key configured, addressLookupAvailable() is
   false and the form uses manual address entry. A failed request returns an
   error message but never breaks the form.
   ===================================================================== */
const KEY = import.meta.env.VITE_ADDRESS_LOOKUP_KEY;

export interface AddressOption {
  line1: string;
  line2: string;
  city: string;
  county: string;
  postcode: string;
  /** Human-readable single-line summary for the dropdown. */
  label: string;
}

export interface AddressLookupResult {
  /** False when no provider key is configured (fall back to manual entry). */
  available: boolean;
  addresses: AddressOption[];
  error?: string;
}

/** True when a lookup provider is configured. */
export function addressLookupAvailable(): boolean {
  return Boolean(KEY);
}

/** Look up addresses at a postcode. Never throws. */
export async function lookupAddresses(postcodeRaw: string): Promise<AddressLookupResult> {
  if (!KEY) return { available: false, addresses: [] };
  const postcode = (postcodeRaw || '').trim();
  if (!postcode) return { available: true, addresses: [] };

  try {
    const url = `https://api.ideal-postcodes.co.uk/v1/postcodes/${encodeURIComponent(postcode)}?api_key=${encodeURIComponent(KEY)}`;
    const res = await fetch(url);
    if (!res.ok) {
      return {
        available: true,
        addresses: [],
        error: res.status === 404 ? 'No addresses found for that postcode.' : 'Address lookup is unavailable right now. Enter the address manually.',
      };
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const data: any = await res.json();
    // Ideal Postcodes wraps results in { result: [...] }; an empty/missing
    // result array means no addresses at that postcode.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results: any[] = Array.isArray(data.result) ? data.result : [];
    if (!results.length) {
      return { available: true, addresses: [], error: 'No addresses found for that postcode.' };
    }
    const pc = String(results[0]?.postcode || postcode).toUpperCase();
    const addresses: AddressOption[] = results.map((a: any) => {

      results.forEach((a, i) => {
        console.log(`Address ${i}`, a);
      });
      const line1 = a.line_1 || '';
      const line2 = [a.line_2, a.line_3, a.line_4].filter(Boolean).join(', ');
      const city = a.post_town || '';
      const county = a.county || '';
      return { line1, line2, city, county, postcode: pc, label: [line1, line2, city].filter(Boolean).join(', ') };
    });
    return { available: true, addresses };
  } catch {
    return { available: true, addresses: [], error: 'Address lookup is unavailable right now. Enter the address manually.' };
  }
}