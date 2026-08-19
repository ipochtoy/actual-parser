# eBay incident register

2026-08-19 | night-2026-08-19-ebay-fedex | Ночной обход остановился после eBay и не запустил Amazon | 140 подтверждённых eBay-карточек остались в durable queue после трёх бесполезных повторов первой карточки | content-ebay принимал bare 12/15-digit FedEx, а screenshot crop classifier отвергал тот же трек и считал отправление неотправленным | Parser Pro | `67e872c` — единый background pattern с FedEx и behavioral test exact track `383250549190` | Любой новый формат трека обязан проходить parser и screenshot consumer одним regression-сценарием | fixed
