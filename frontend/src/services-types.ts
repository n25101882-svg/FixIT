import type { ServiceCategory } from "./api";
import type { PublicMaster } from "./ClientOffers";
export interface Service {
  id: string; title: string; category: ServiceCategory; description: string | null; priceEstimate: string | null; isActive: boolean;
}
export interface Page {
  services: Service[]; page: number; limit: number; total: number; totalPages: number;
}
export interface CatalogPageData extends Omit<Page, "services"> { services: (Service & { master: PublicMaster })[] }
export interface MasterPageData extends Page { master: PublicMaster }
