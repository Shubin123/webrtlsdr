#ifndef FL2K_WEB_LIBUSB_H
#define FL2K_WEB_LIBUSB_H
#include <stdint.h>
#include <sys/types.h>
#define LIBUSB_API_VERSION 0
#define LIBUSB_REQUEST_TYPE_VENDOR 0x40
#define LIBUSB_ENDPOINT_IN 0x80
#define LIBUSB_ENDPOINT_OUT 0
#define LIBUSB_ERROR_ACCESS -3
typedef struct libusb_context { int unused; } libusb_context;
typedef struct libusb_device { int index; } libusb_device;
typedef struct libusb_device_handle { int index; } libusb_device_handle;
struct libusb_device_descriptor { uint16_t idVendor; uint16_t idProduct; };
int libusb_init(libusb_context **context);
void libusb_exit(libusb_context *context);
void libusb_set_debug(libusb_context *context, int level);
ssize_t libusb_get_device_list(libusb_context *context, libusb_device ***list);
void libusb_free_device_list(libusb_device **list, int unref);
int libusb_get_device_descriptor(libusb_device *device, struct libusb_device_descriptor *descriptor);
int libusb_open(libusb_device *device, libusb_device_handle **handle);
void libusb_close(libusb_device_handle *handle);
int libusb_kernel_driver_active(libusb_device_handle *handle, int interface_number);
int libusb_detach_kernel_driver(libusb_device_handle *handle, int interface_number);
int libusb_claim_interface(libusb_device_handle *handle, int interface_number);
int libusb_release_interface(libusb_device_handle *handle, int interface_number);
int libusb_set_interface_alt_setting(libusb_device_handle *handle, int interface_number, int alternate);
int libusb_control_transfer(libusb_device_handle *handle, uint8_t type, uint8_t request, uint16_t value, uint16_t index, unsigned char *data, uint16_t length, unsigned int timeout);
#endif
