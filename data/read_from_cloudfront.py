import xarray as xr

ds = xr.open_zarr(
    "https://cdn.apps.geoglows.org/ggg/grace-gldas-water-balance-1.0.zarr",
    zarr_version=3, consolidated=True
)
print(ds)
